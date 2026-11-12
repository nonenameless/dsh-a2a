/**
 * In-memory task store, waiter registry, and SSE fan-out.
 *
 * One task owns at most one live DSH Agent turn. The manager is deliberately
 * transport-free: it knows nothing about HTTP, JSON-RPC, or SSE, so the state
 * machine and wait/stream semantics can be tested with a fake executor.
 *
 * @module @local/dsh-a2a/inbound/task-manager
 */

import { randomUUID } from 'node:crypto'
import type { Config } from '../config.ts'
import {
  A2A_ERROR,
  agentMessage,
  dataPart,
  isTerminalState,
  textPart,
  type Message,
  type Task,
  type TaskArtifactUpdateEvent,
  type TaskEvent,
  type TaskState,
  type TaskStatusUpdateEvent,
} from '../../shared/protocol.ts'
import { A2AProtocolError, messageOf } from '../../shared/errors.ts'
import { assertTransition } from './task-machine.ts'
import type {
  PendingQuestion,
  PendingQuestionRequest,
  SendTaskInput,
  TaskExecutor,
  TaskRecord,
} from './task-types.ts'

/** Maximum retained messages in one task history. */
const MAX_HISTORY = 100

/** Maximum retained events per task for diagnostics/replay. */
const MAX_EVENTS = 256

/**
 * Maximum retained task records in one process. A long-lived A2A connection
 * accumulates one record per task; terminal records are dropped oldest-first
 * once this cap is passed, so memory stays bounded. Active tasks are never
 * dropped, and a dropped task's transcript remains in its DSH Session.
 */
const MAX_RETAINED_TASKS = 500

/**
 * Owns task records for the process lifetime.
 *
 * Task records are intentionally process-local: the durable transcript lives in
 * the DSH Session log, and a restarted process discovers `contextId` history by
 * resuming that Session rather than by replaying A2A tasks.
 */
export class TaskManager {
  private readonly tasks = new Map<string, TaskRecord>()
  private readonly activeByContext = new Map<string, string>()
  private disposed = false

  /**
   * @param config - resolved plugin configuration.
   * @param executor - DSH Agent adapter that drives accepted tasks.
   */
  constructor(
    private readonly config: Config,
    private readonly executor: TaskExecutor,
    private readonly onStatus?: (record: TaskRecord, state: TaskState) => void,
  ) {}

  /**
   * Accept or continue one task.
   *
   * @param input - normalized send input.
   * @returns the settled task for blocking calls, or the current snapshot otherwise.
   * @throws {A2AProtocolError} for a missing, busy, terminal, or mismatched task.
   */
  async send(input: SendTaskInput, peer?: string): Promise<Task> {
    this.assertNotDisposed()

    const existing = input.taskId === undefined ? undefined : this.tasks.get(input.taskId)
    if (existing !== undefined) return this.continueExisting(existing, input)
    if (input.taskId !== undefined && input.taskIdMode === 'continue') {
      throw new A2AProtocolError(A2A_ERROR.taskNotFound, `Task not found: ${input.taskId}`, { id: input.taskId })
    }

    // A context-only continuation is the natural A2A multi-turn shorthand:
    // route it to the one task waiting for input in that context.
    if (input.taskId === undefined && input.contextId !== undefined) {
      const activeId = this.activeByContext.get(input.contextId)
      const active = activeId === undefined ? undefined : this.tasks.get(activeId)
      if (active !== undefined && active.state === 'input-required') {
        return this.continueExisting(active, input)
      }
    }

    if (input.contextId !== undefined) {
      const active = this.activeByContext.get(input.contextId)
      if (active !== undefined) {
        throw new A2AProtocolError(
          A2A_ERROR.invalidRequest,
          `Context ${input.contextId} already has active task ${active}`,
          { contextId: input.contextId, taskId: active },
        )
      }
    }

    const record = this.createRecord(input, peer)
    this.tasks.set(record.id, record)
    this.activeByContext.set(record.contextId, record.id)
    this.emitStatus(record, false)
    void this.startNew(record, input.message)

    const result = input.blocking ? await this.waitForSettle(record) : this.snapshot(record)
    return input.historyLength === undefined ? result : this.snapshot(record, input.historyLength)
  }

  /**
   * Read one task.
   *
   * @param id - task id.
   * @param historyLength - maximum history entries to include.
   * @returns the current wire task.
   * @throws {A2AProtocolError} with `-32001` when absent.
   */
  get(id: string, historyLength?: number): Task {
    return this.snapshot(this.requireTask(id), historyLength)
  }

  /**
   * Cancel one non-terminal task.
   *
   * @param id - task id.
   * @returns the canceled task snapshot.
   * @throws {A2AProtocolError} when absent or already terminal.
   */
  cancel(id: string): Task {
    const record = this.requireTask(id)
    if (isTerminalState(record.state)) {
      throw new A2AProtocolError(A2A_ERROR.taskNotCancelable, `Task ${id} is already ${record.state}`, { id, state: record.state })
    }

    record.pendingQuestion?.reject(new Error('Task canceled by the caller'))
    record.pendingQuestion = undefined
    this.executor.cancel(record)
    this.finish(record, 'canceled', 'Task canceled.')
    return this.snapshot(record)
  }

  /**
   * Subscribe to one task's status and artifact events.
   *
   * @param id - task id.
   * @param callback - invoked for each replayed and live event.
   * @param replay - whether to emit the current status and artifact first.
   * @returns the disposer removing this subscription.
   */
  subscribe(id: string, callback: (event: TaskEvent) => void, replay: boolean): () => void {
    const record = this.requireTask(id)
    const subscriber = (event: TaskEvent): void => {
      try {
        callback(event)
      } catch {
        record.subscribers.delete(subscriber)
      }
    }
    record.subscribers.add(subscriber)

    if (replay) {
      callback(this.statusEvent(record))
      if (record.outputText.length > 0) callback(this.artifactEvent(record))
    }
    return () => { record.subscribers.delete(subscriber) }
  }

  /**
   * Count retained tasks by state.
   *
   * @returns active and total counters plus a per-state breakdown.
   */
  stats(): { active: number; total: number; byState: Record<string, number> } {
    const byState: Record<string, number> = {}
    let active = 0
    for (const record of this.tasks.values()) {
      byState[record.state] = (byState[record.state] ?? 0) + 1
      if (!isTerminalState(record.state)) active += 1
    }
    return { active, total: this.tasks.size, byState }
  }

  /**
   * Publish an `input-required` transition and park the question.
   *
   * @param record - task waiting for input.
   * @param request - question request observed from the agent.
   * @param deferred - promise controls the interaction bridge will settle.
   */
  markInputRequired(record: TaskRecord, request: PendingQuestionRequest, deferred: PendingQuestion): void {
    if (isTerminalState(record.state)) {
      deferred.reject(new Error('Task is already terminal'))
      return
    }
    record.pendingQuestion = deferred
    const message = this.questionMessage(record, request)
    record.history.push(message)
    this.setState(record, 'input-required', message)
  }

  /**
   * Append assistant text to the task's result.
   *
   * @param record - owning task.
   * @param text - text emitted by one assistant message.
   */
  appendText(record: TaskRecord, text: string): void {
    if (text.length === 0 || isTerminalState(record.state)) return
    record.outputText += text
    record.updatedAt = Date.now()
  }

  /**
   * Complete one task from executor output.
   *
   * @param record - owning task.
   */
  complete(record: TaskRecord): void {
    if (isTerminalState(record.state)) return
    if (record.outputText.length > 0) {
      record.history.push(agentMessage(randomUUID(), [textPart(record.outputText)], record.contextId, record.id))
      // Streaming clients receive the artifact before the final status frame.
      this.emit(record, this.artifactEvent(record))
    }
    this.finish(record, 'completed', record.outputText.length > 0 ? undefined : 'Task completed with no text output.')
  }

  /**
   * Fail one task.
   *
   * @param record - owning task.
   * @param reason - peer-safe reason.
   */
  fail(record: TaskRecord, reason: string): void {
    if (isTerminalState(record.state)) return
    record.error = reason
    this.finish(record, 'failed', reason)
  }

  /**
   * Release every task, timeout, and executor resource.
   *
   * @returns fulfillment after the executor releases its agents.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    for (const record of this.tasks.values()) {
      if (record.timeout !== undefined) clearTimeout(record.timeout)
      record.pendingQuestion?.reject(new Error('A2A plugin is shutting down'))
      record.pendingQuestion = undefined
    }
    this.tasks.clear()
    this.activeByContext.clear()
    await this.executor.dispose()
  }

  /** Continue a task that is waiting for input, or reject a busy/terminal one. */
  private async continueExisting(record: TaskRecord, input: SendTaskInput): Promise<Task> {
    if (input.contextId !== undefined && input.contextId !== record.contextId) {
      throw new A2AProtocolError(
        A2A_ERROR.invalidParams,
        `Task ${record.id} belongs to context ${record.contextId}, not ${input.contextId}`,
        { field: 'message.contextId' },
      )
    }
    if (isTerminalState(record.state)) {
      throw new A2AProtocolError(A2A_ERROR.invalidRequest, `Task ${record.id} is already ${record.state}`, { id: record.id })
    }
    if (record.state !== 'input-required') {
      throw new A2AProtocolError(A2A_ERROR.invalidRequest, `Task ${record.id} is already working`, { id: record.id })
    }

    record.history.push(input.message)
    record.pendingQuestion = undefined
    this.setState(record, 'working')
    void this.runAnswer(record, input.message)
    const result = input.blocking ? await this.waitForSettle(record) : this.snapshot(record)
    return input.historyLength === undefined ? result : this.snapshot(record, input.historyLength)
  }

  /** Create one record with a deadline. */
  private createRecord(input: SendTaskInput, peer?: string): TaskRecord {
    const now = Date.now()
    const record: TaskRecord = {
      id: input.taskId ?? randomUUID(),
      contextId: input.contextId ?? randomUUID(),
      state: 'submitted',
      createdAt: now,
      updatedAt: now,
      history: [input.message],
      outputText: '',
      ...peer === undefined ? {} : { peer },
      waiters: new Set(),
      subscribers: new Set(),
      events: [],
    }
    record.timeout = setTimeout(() => { this.expire(record) }, this.config.server.timeoutMs)
    record.timeout.unref?.()
    return record
  }

  /** Start a fresh task and contain executor failures. */
  private async startNew(record: TaskRecord, message: Message): Promise<void> {
    this.setState(record, 'working')
    try {
      await this.executor.run(record, message)
    } catch (error: unknown) {
      this.fail(record, messageOf(error))
    }
  }

  /** Deliver an input-required answer and contain executor failures. */
  private async runAnswer(record: TaskRecord, message: Message): Promise<void> {
    try {
      await this.executor.answer(record, message)
    } catch (error: unknown) {
      this.fail(record, messageOf(error))
    }
  }

  /** Apply one legal state transition and publish it. */
  private setState(record: TaskRecord, next: TaskState, statusMessage?: Message): void {
    if (record.state === next) {
      if (statusMessage !== undefined) record.statusMessage = statusMessage
      return
    }
    assertTransition(record.state, next)
    record.state = next
    record.updatedAt = Date.now()
    if (statusMessage !== undefined) record.statusMessage = statusMessage
    else if (next === 'working' || next === 'submitted' || isTerminalState(next)) record.statusMessage = undefined
    try {
      this.onStatus?.(record, next)
    } catch {
      // Observation must never change task settlement.
    }
    this.emitStatus(record, isTerminalState(next))
    if (next === 'input-required' || isTerminalState(next)) this.settle(record)
    if (isTerminalState(next)) this.release(record)
  }

  /** Finish a task in a terminal state with an optional reason message. */
  private finish(record: TaskRecord, state: 'completed' | 'canceled' | 'failed', reason?: string): void {
    if (isTerminalState(record.state)) return
    if (reason !== undefined) {
      record.statusMessage = agentMessage(randomUUID(), [textPart(reason)], record.contextId, record.id)
      record.history.push(record.statusMessage)
    } else {
      record.statusMessage = undefined
    }
    this.setState(record, state, record.statusMessage)
  }

  /** Enforce the overall deadline. */
  private expire(record: TaskRecord): void {
    if (isTerminalState(record.state)) return
    record.pendingQuestion?.reject(new Error('Task timed out waiting for input'))
    record.pendingQuestion = undefined
    try {
      this.executor.cancel(record)
    } catch (error: unknown) {
      // This runs from a timer: an escaping failure here would take the Host
      // process down instead of failing one task.
      void error
    }
    this.fail(record, `Task timed out after ${String(this.config.server.timeoutMs)} ms`)
  }

  /** Drop the oldest terminal records once retention passes its cap. */
  private evict(): void {
    if (this.tasks.size <= MAX_RETAINED_TASKS) return
    for (const [id, record] of this.tasks) {
      if (this.tasks.size <= MAX_RETAINED_TASKS) break
      if (!isTerminalState(record.state)) continue
      this.tasks.delete(id)
    }
  }

  /** Clear per-task resources after a terminal transition. */
  private release(record: TaskRecord): void {
    if (record.timeout !== undefined) clearTimeout(record.timeout)
    record.timeout = undefined
    if (this.activeByContext.get(record.contextId) === record.id) {
      this.activeByContext.delete(record.contextId)
    }
    record.pendingQuestion = undefined
    this.evict()
  }

  /** Resolve every blocking caller with the current settled snapshot. */
  private settle(record: TaskRecord): void {
    if (record.waiters.size === 0) return
    const snapshot = this.snapshot(record)
    for (const resolve of record.waiters) resolve(snapshot)
    record.waiters.clear()
  }

  /** Wait for `input-required` or a terminal state. */
  private waitForSettle(record: TaskRecord): Promise<Task> {
    if (record.state === 'input-required' || isTerminalState(record.state)) {
      return Promise.resolve(this.snapshot(record))
    }
    return new Promise(resolve => { record.waiters.add(resolve) })
  }

  /** Require one task or throw `-32001`. */
  private requireTask(id: string): TaskRecord {
    const record = this.tasks.get(id)
    if (record === undefined) {
      throw new A2AProtocolError(A2A_ERROR.taskNotFound, `Task not found: ${id}`, { id })
    }
    return record
  }

  /** Publish one status event to subscribers. */
  private emitStatus(record: TaskRecord, final: boolean): void {
    this.emit(record, this.statusEvent(record, final))
  }

  /** Build a current status event. */
  private statusEvent(record: TaskRecord, final = isTerminalState(record.state)): TaskStatusUpdateEvent {
    return {
      kind: 'status-update',
      taskId: record.id,
      contextId: record.contextId,
      status: {
        state: record.state,
        timestamp: new Date(record.updatedAt).toISOString(),
        ...record.statusMessage === undefined ? {} : { message: record.statusMessage },
      },
      final,
    }
  }

  /** Build the current artifact event. */
  private artifactEvent(record: TaskRecord): TaskArtifactUpdateEvent {
    return {
      kind: 'artifact-update',
      taskId: record.id,
      contextId: record.contextId,
      artifact: {
        artifactId: `${record.id}-output`,
        name: 'result',
        parts: [textPart(record.outputText)],
      },
      lastChunk: true,
    }
  }

  /** Fan one event out to the bounded buffer and live subscribers. */
  private emit(record: TaskRecord, event: TaskEvent): void {
    record.events.push(event)
    if (record.events.length > MAX_EVENTS) record.events.shift()
    for (const subscriber of [...record.subscribers]) {
      try {
        subscriber(event)
      } catch {
        record.subscribers.delete(subscriber)
      }
    }
  }

  /** Project one record onto the A2A wire task. */
  private snapshot(record: TaskRecord, historyLength?: number): Task {
    const requested = historyLength === undefined ? MAX_HISTORY : Math.max(0, Math.min(historyLength, MAX_HISTORY))
    const history = requested === 0 ? [] : record.history.slice(-requested)
    const artifacts = record.outputText.length === 0
      ? []
      : [{
        artifactId: `${record.id}-output`,
        name: 'result',
        parts: [textPart(record.outputText)],
      }]
    return {
      kind: 'task',
      id: record.id,
      contextId: record.contextId,
      status: {
        state: record.state,
        timestamp: new Date(record.updatedAt).toISOString(),
        ...record.statusMessage === undefined ? {} : { message: record.statusMessage },
      },
      ...history.length === 0 ? {} : { history },
      ...artifacts.length === 0 ? {} : { artifacts },
    }
  }

  /** Build the `input-required` status message. */
  private questionMessage(record: TaskRecord, request: PendingQuestionRequest): Message {
    const text = request.questions.map(question => question.question).join('\n')
    return agentMessage(
      randomUUID(),
      [
        textPart(text),
        dataPart({
          questions: request.questions.map(question => ({
            id: question.id,
            question: question.question,
            ...question.header === undefined ? {} : { header: question.header },
            ...question.options === undefined ? {} : { options: question.options },
            ...question.multiSelect === undefined ? {} : { multiSelect: question.multiSelect },
          })),
        }),
      ],
      record.contextId,
      record.id,
    )
  }

  /** Reject use after disposal. */
  private assertNotDisposed(): void {
    if (this.disposed) throw new A2AProtocolError(A2A_ERROR.internalError, 'A2A task manager is shutting down')
  }
}
