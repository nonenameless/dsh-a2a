/**
 * DSH Agent adapter for inbound A2A tasks.
 *
 * One A2A `contextId` maps to one deterministic DSH Session. The adapter
 * creates or resumes that Session, forwards user messages with
 * `agent.followup()`, and translates session events back into task output.
 *
 * `input-required` is bridged through the scoped `user-questions/request`
 * waterfall: the handler parks the question and returns a promise that the
 * next A2A message resolves. Approvals are answered with the reject option
 * rather than left hanging, because an A2A task has no human approver.
 *
 * @module @local/dsh-a2a/inbound/agent-executor
 */

import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle, AgentOptions } from '@deepseek-ai/dsh-agent'
import { createUserMessage, ReasoningEffortId, type ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-user-approval'
import type { AskUserQuestionAnswer, AskUserQuestionRequestEvent } from '@deepseek-ai/dsh-user-questions/types'
import type { Config } from '../config.ts'
import type { AgentDefaultModelService, AgentsService } from '../dsh.ts'
import {
  isRecord,
  isTerminalState,
  partKind,
  textOfParts,
  type Message,
} from '../../shared/protocol.ts'
import { A2AProtocolError, invalidParams, messageOf } from '../../shared/errors.ts'
import type {
  PendingQuestion,
  PendingQuestionAnswer,
  PendingQuestionRequest,
  TaskExecutor,
  TaskRecord,
} from './task-types.ts'

/** Session persistence subset used to decide between resume and create. */
interface SessionPersistenceLike {
  stat(id: SessionId): Promise<{ header: { origin?: string } } | undefined>
}

/** Sink implemented by the TaskManager. */
export interface TaskSink {
  markInputRequired(record: TaskRecord, request: PendingQuestionRequest, deferred: PendingQuestion): void
  appendText(record: TaskRecord, text: string): void
  complete(record: TaskRecord): void
  fail(record: TaskRecord, reason: string): void
}

/** One live agent bound to an A2A context. */
interface AgentEntry {
  contextId: string
  sessionId: SessionId
  agent: Agent
  handle?: AgentHandle | undefined
  task?: TaskRecord | undefined
  question?: PendingQuestion | undefined
  disposeQuestion?: (() => void) | undefined
  disposeApproval?: (() => void) | undefined
  /** Last time a task used this context, for idle release. */
  lastUsedAt?: number | undefined
}

/**
 * Live agents kept for idle contexts. A long-lived A2A connection accumulates
 * one context per peer task, and every live agent keeps its Session in memory;
 * beyond this cap or the idle window the agent is released and the next message
 * resumes the same persisted Session.
 */
const MAX_IDLE_AGENTS = 32

/** Idle time after which one context's live agent is released. */
const AGENT_IDLE_MS = 10 * 60_000

/** Runtime Agent adapter. */
export class AgentExecutor implements TaskExecutor {
  private readonly byContext = new Map<string, AgentEntry>()
  private readonly bySession = new Map<SessionId, AgentEntry>()
  private readonly disposers: Array<() => void> = []
  /** In-flight idle disposals, keyed by the session they release. */
  private readonly retiring = new Map<SessionId, Promise<void>>()
  private sink: TaskSink | undefined

  /**
   * @param ctx - plugin context carrying agents and session services.
   * @param config - resolved plugin configuration.
   */
  constructor(
    private readonly ctx: Context,
    private readonly config: Config,
  ) {
    this.disposers.push(ctx.on('session/event', (session, event) => { this.onSessionEvent(session, event) }))
    this.disposers.push(ctx.on('agent/disposed', ({ agent }) => { this.onAgentDisposed(agent) }))
  }

  /**
   * Attach the task sink after construction.
   *
   * @param sink - task manager that receives output and state changes.
   */
  bindSink(sink: TaskSink): void {
    this.sink = sink
  }

  /**
   * Drive one task with a user message.
   *
   * @param record - mutable task record.
   * @param message - normalized user message.
   */
  async run(record: TaskRecord, message: Message): Promise<void> {
    const sink = this.requireSink()
    this.pruneIdle()
    const entry = await this.ensureEntry(record.contextId)
    entry.lastUsedAt = Date.now()
    // Cancellation can win while the agent is still materializing.
    if (isTerminalState(record.state)) return
    if (entry.task !== undefined && !isTerminalState(entry.task.state)) {
      throw new A2AProtocolError(-32600, `Context ${record.contextId} already has a running task`)
    }
    entry.task = record
    record.agent = entry.agent
    record.sessionId = entry.sessionId
    try {
      entry.agent.followup(createUserMessage({ content: toContent(message), source: { kind: 'user' } }))
    } catch (error: unknown) {
      entry.task = undefined
      sink.fail(record, messageOf(error))
    }
  }

  /**
   * Deliver an answer to a pending `input-required` question.
   *
   * @param record - mutable task record.
   * @param message - normalized user message carrying the answer.
   */
  async answer(record: TaskRecord, message: Message): Promise<void> {
    if (isTerminalState(record.state)) return
    const entry = this.byContext.get(record.contextId)
    if (entry === undefined) throw new A2AProtocolError(-32603, 'The task has no live agent')
    entry.lastUsedAt = Date.now()
    const question = entry.question
    if (question === undefined) {
      // The question settled through another path; keep the input instead of
      // dropping it, and let the agent answer in a fresh turn.
      entry.task = record
      entry.agent.followup(createUserMessage({ content: toContent(message), source: { kind: 'user' } }))
      return
    }
    entry.question = undefined
    question.resolve(answerFromMessage(message, question.request.questions))
  }

  /**
   * Abort the agent work owned by this task.
   *
   * @param record - mutable task record.
   */
  cancel(record: TaskRecord): void {
    const entry = this.byContext.get(record.contextId)
    if (entry === undefined) return
    entry.question?.reject(new Error('Task canceled'))
    entry.question = undefined
    entry.task = undefined
    entry.agent.cancel({ kind: 'user' })
  }

  /**
   * Release listeners and owned agent handles.
   *
   * @returns fulfillment after every owned agent settles.
   */
  async dispose(): Promise<void> {
    for (const dispose of this.disposers.splice(0)) {
      try {
        dispose()
      } catch (error: unknown) {
        this.ctx.logger.warn('dsh-a2a: executor listener disposal failed', error)
      }
    }
    for (const entry of this.byContext.values()) {
      entry.question?.reject(new Error('A2A plugin is shutting down'))
      entry.question = undefined
      entry.disposeQuestion?.()
      entry.disposeApproval?.()
      if (entry.handle !== undefined) {
        await entry.handle.dispose().catch((error: unknown) => {
          this.ctx.logger.warn('dsh-a2a: agent disposal failed', error)
        })
      }
    }
    this.byContext.clear()
    this.bySession.clear()
    await Promise.allSettled([...this.retiring.values()])
    this.retiring.clear()
  }

  /** Resolve or create the agent for one context. */
  private async ensureEntry(contextId: string): Promise<AgentEntry> {
    const agents = this.requireAgents()
    const existing = this.byContext.get(contextId)
    if (existing !== undefined && agents.get(existing.sessionId) === existing.agent) return existing
    if (existing !== undefined) this.dropEntry(existing)

    const sessionId = SessionId(`a2a-${createHash('sha256').update(contextId, 'utf8').digest('hex').slice(0, 32)}`)
    const pendingRetire = this.retiring.get(sessionId)
    if (pendingRetire !== undefined) await pendingRetire
    const live = agents.get(sessionId)
    if (live !== undefined) return this.registerEntry({ contextId, sessionId, agent: live })

    const agentOptions = this.resolveAgentOptions()
    const cwd = this.config.server.cwd.length > 0 ? this.config.server.cwd : process.cwd()
    let handle: AgentHandle | undefined

    const persistence = this.ctx.get('sessionPersistence') as SessionPersistenceLike | undefined
    if (persistence !== undefined) {
      try {
        const stat = await persistence.stat(sessionId)
        if (stat !== undefined) {
          handle = await agents.resume({ resumeSessionId: sessionId, agentOptions })
        }
      } catch (error: unknown) {
        this.ctx.logger.warn(`dsh-a2a: could not resume session ${String(sessionId)}; creating a fresh one`, error)
      }
    }

    handle ??= await agents.create({
      sessionId,
      meta: { cwd },
      agentOptions,
    })

    return this.registerEntry({ contextId, sessionId, agent: handle.agent, handle })
  }

  /** Resolve the agents service through the optional lookup, never the property proxy. */
  private requireAgents(): AgentsService {
    const agents = this.ctx.get('agents') as AgentsService | undefined
    if (agents === undefined) {
      throw new A2AProtocolError(-32603, 'The DSH agents service is unavailable; inbound A2A tasks cannot run')
    }
    return agents
  }

  /** Publish one entry and install its scoped question bridge. */
  private registerEntry(entry: AgentEntry): AgentEntry {
    entry.lastUsedAt = Date.now()
    entry.disposeQuestion = entry.agent.ctx.on('user-questions/request', (request, next) => (
      this.onQuestion(entry, request, next)
    ))
    // An A2A task has no human approver. Refuse rather than leaving the tool
    // blocked forever; the agent receives the rejection as a tool result.
    entry.disposeApproval = entry.agent.ctx.on('approval/request', () => Promise.resolve('rejected'))
    this.byContext.set(entry.contextId, entry)
    this.bySession.set(entry.sessionId, entry)
    return entry
  }

  /** Remove one entry without disposing an agent owned by another creator. */
  private dropEntry(entry: AgentEntry): void {
    entry.question?.reject(new Error('The agent was replaced'))
    entry.question = undefined
    entry.disposeQuestion?.()
    entry.disposeQuestion = undefined
    entry.disposeApproval?.()
    entry.disposeApproval = undefined
    if (this.byContext.get(entry.contextId) === entry) this.byContext.delete(entry.contextId)
    if (this.bySession.get(entry.sessionId) === entry) this.bySession.delete(entry.sessionId)
  }

  /**
   * Release agents for contexts that are idle: first those past the idle
   * window, then the least recently used while the context count stays above
   * its cap. An entry running a task is never released.
   */
  private pruneIdle(): void {
    const now = Date.now()
    for (const entry of [...this.byContext.values()]) {
      if (entry.task !== undefined) continue
      if (now - (entry.lastUsedAt ?? now) >= AGENT_IDLE_MS) this.retire(entry)
    }
    let excess = this.byContext.size - MAX_IDLE_AGENTS
    if (excess <= 0) return
    const oldest = [...this.byContext.values()]
      .filter(entry => entry.task === undefined)
      .sort((left, right) => (left.lastUsedAt ?? 0) - (right.lastUsedAt ?? 0))
    for (const entry of oldest) {
      if (excess <= 0) break
      this.retire(entry)
      excess -= 1
    }
  }

  /** Release one idle context's agent; the persisted Session survives for resume. */
  private retire(entry: AgentEntry): void {
    const handle = entry.handle
    const sessionId = entry.sessionId
    this.dropEntry(entry)
    if (handle === undefined) return
    // A new task for the same context may arrive while this disposal is in
    // flight; ensureEntry waits for it so a disposed agent is never reused.
    const disposal: Promise<void> = handle.dispose()
      .catch((error: unknown) => {
        this.ctx.logger.warn('dsh-a2a: idle agent disposal failed', error)
      })
      .finally(() => {
        if (this.retiring.get(sessionId) === disposal) this.retiring.delete(sessionId)
      })
    this.retiring.set(sessionId, disposal)
  }

  /** Resolve the model route or fail before creating an agent. */
  private resolveAgentOptions(): AgentOptions {
    const configured = this.config.server.model
    let resolved: { provider: string; model: string; reasoningEffort?: string } | undefined
    if (configured.provider.length > 0) {
      resolved = configured
    } else {
      resolved = (this.ctx.get('agentDefaultModel') as AgentDefaultModelService | undefined)?.currentSelection()
    }

    if (resolved === undefined || resolved.provider.length === 0 || resolved.model.length === 0) {
      throw new A2AProtocolError(
        -32603,
        'No model route is configured for inbound A2A tasks; set server.model or the DSH default model',
      )
    }
    return {
      provider: resolved.provider,
      model: resolved.model,
      ...resolved.reasoningEffort === undefined || resolved.reasoningEffort.length === 0
        ? {}
        : { reasoningEffort: ReasoningEffortId(resolved.reasoningEffort) },
    }
  }

  /** Translate one committed session event into task output. */
  private onSessionEvent(session: Session, event: SessionEvent): void {
    const entry = this.bySession.get(session.id)
    if (entry === undefined) return
    const record = entry.task
    if (record === undefined || isTerminalState(record.state)) return

    switch (event.type) {
      case 'assistant/message': {
        const text = textOfContent(event.data.message.content)
        if (text.length > 0) this.requireSink().appendText(record, text)
        break
      }
      case 'turn/end':
        this.finishTurn(entry, record, event.data.reason)
        break
      default:
        break
    }
  }

  /** Map one turn termination onto the task lifecycle. */
  private finishTurn(entry: AgentEntry, record: TaskRecord, reason: { kind: string; error?: { message?: string } }): void {
    entry.task = undefined
    entry.lastUsedAt = Date.now()
    entry.question?.reject(new Error('The agent turn ended before the question was answered'))
    entry.question = undefined

    switch (reason.kind) {
      case 'completed':
        this.requireSink().complete(record)
        break
      case 'aborted':
        this.requireSink().fail(record, 'Agent turn was canceled.')
        break
      case 'error':
        this.requireSink().fail(record, reason.error?.message ?? 'Agent turn failed.')
        break
      case 'blocked':
        this.requireSink().fail(record, 'Agent turn was blocked.')
        break
      case 'max-tokens':
        this.requireSink().fail(record, 'Agent reached its output-token limit.')
        break
      default:
        this.requireSink().fail(record, `Agent turn ended with ${reason.kind}.`)
        break
    }
  }

  /** Park a question and resolve it on the next A2A message. */
  private onQuestion(
    entry: AgentEntry,
    request: AskUserQuestionRequestEvent,
    next: () => Promise<AskUserQuestionAnswer>,
  ): Promise<AskUserQuestionAnswer> {
    const record = entry.task
    if (record === undefined || isTerminalState(record.state) || entry.question !== undefined) return next()

    let settleResolve!: (answer: AskUserQuestionAnswer) => void
    let settleReject!: (error: Error) => void
    const promise = new Promise<AskUserQuestionAnswer>((resolve, reject) => {
      settleResolve = resolve
      settleReject = reject
    })

    const cleanup = (): void => {
      request.signal?.removeEventListener('abort', onAbort)
    }
    const deferred: PendingQuestion = {
      request,
      resolve: (answer) => { cleanup(); entry.question = undefined; settleResolve(answer) },
      reject: (error) => { cleanup(); entry.question = undefined; settleReject(error) },
    }
    const onAbort = (): void => {
      deferred.reject(new Error('The question was canceled'))
      this.requireSink().fail(record, 'The question was canceled')
    }
    if (request.signal?.aborted === true) {
      deferred.reject(new Error('The question was canceled'))
      return promise
    }
    request.signal?.addEventListener('abort', onAbort, { once: true })

    entry.question = deferred
    this.requireSink().markInputRequired(record, request, deferred)
    return promise
  }

  /** Fail a task when its agent disappears. */
  private onAgentDisposed(agent: Agent): void {
    const entry = this.bySession.get(agent.id)
    if (entry === undefined) return
    const record = entry.task
    entry.task = undefined
    entry.question?.reject(new Error('The agent was disposed'))
    entry.question = undefined
    if (record !== undefined && !isTerminalState(record.state)) {
      this.requireSink().fail(record, 'The agent was disposed before the task finished.')
    }
    this.dropEntry(entry)
  }

  /** Require the sink that is bound during plugin activation. */
  private requireSink(): TaskSink {
    if (this.sink === undefined) throw new Error('dsh-a2a: task sink is not bound')
    return this.sink
  }
}

/** Concatenate the text blocks of one assistant message. */
function textOfContent(content: readonly ContentBlock[]): string {
  return content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
}

/** Convert A2A parts into DSH content blocks. */
function toContent(message: Message): ContentBlock[] {
  const content: ContentBlock[] = []
  for (const part of message.parts) {
    const kind = partKind(part)
    if (kind === 'text') {
      content.push({ type: 'text', text: (part as { text: string }).text })
    } else if (kind === 'data') {
      const data = (part as { data: Record<string, unknown> }).data
      content.push({ type: 'text', text: `\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\`` })
    } else if (kind === 'file') {
      const file = (part as { file: { name?: string; mimeType?: string; uri?: string; bytes?: string } }).file
      content.push({
        type: 'text',
        text: `[file${file.name === undefined ? '' : ` ${file.name}`}${file.mimeType === undefined ? '' : `, ${file.mimeType}`}${file.uri === undefined ? '' : `, ${file.uri}`}]`,
      })
    }
  }
  if (content.length === 0) throw invalidParams('message.parts must contain at least one supported part', 'message.parts')
  return content
}

/** Map an A2A continuation message onto a structured question answer. */
export function answerFromMessage(
  message: Message,
  questions: PendingQuestionRequest['questions'],
): PendingQuestionAnswer {
  const structured = message.parts
    .filter(part => partKind(part) === 'data')
    .map(part => (part as { data: Record<string, unknown> }).data)
    .find(data => Array.isArray(data.answers))
  if (structured !== undefined) {
    const answers = structured.answers
    if (Array.isArray(answers)) {
      return {
        answers: answers.flatMap(answer => {
          if (!isRecord(answer) || typeof answer.id !== 'string') return []
          const selected = Array.isArray(answer.selected)
            ? answer.selected.filter((value): value is string => typeof value === 'string')
            : []
          return [{
            id: answer.id,
            selected,
            ...typeof answer.custom === 'string' ? { custom: answer.custom } : {},
          }]
        }),
      }
    }
  }

  const text = textOfParts(message.parts).trim()
  const selectedLabels = text.split(',').map(value => value.trim()).filter(value => value.length > 0)
  return {
    answers: questions.map(question => {
      const options = question.options?.map(option => option.label) ?? []
      const selected = options.filter(label => selectedLabels.some(value => value.toLowerCase() === label.toLowerCase()))
      if (selected.length > 0) return { id: question.id, selected }
      if (question.intent?.kind === 'approval' && question.intent.reject !== undefined) {
        return { id: question.id, selected: [question.intent.reject], ...text.length > 0 ? { custom: text } : {} }
      }
      return { id: question.id, selected: [], ...text.length > 0 ? { custom: text } : {} }
    }),
  }
}
