/**
 * Internal task records and the executor seam.
 *
 * These types never cross the wire; `Task` in `protocol.ts` is the wire value.
 * Keeping the mutable record out of the protocol module makes the state
 * machine and SSE layer easier to test without an event loop.
 *
 * @module @local/dsh-a2a/inbound/task-types
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { Message, Task, TaskEvent, TaskState } from '../../shared/protocol.ts'

/** One question request observed from the DSH interaction waterfall. */
export interface PendingQuestionRequest {
  questions: Array<{
    id: string
    question: string
    header?: string
    detail?: string
    options?: Array<{ label: string }>
    multiSelect?: boolean
    intent?: { kind: string; approve?: string; reject?: string; always?: string }
  }>
  signal?: AbortSignal
  wait?: { callId: string; timed?: boolean }
}

/** Answer batch expected by the user-questions service. */
export interface PendingQuestionAnswer {
  answers: Array<{ id: string; selected: string[]; custom?: string }>
}

/** Deferred question waiting for the next A2A message. */
export interface PendingQuestion {
  request: PendingQuestionRequest
  resolve(answer: PendingQuestionAnswer): void
  reject(error: Error): void
}

/** Mutable state for one A2A task. */
export interface TaskRecord {
  /** A2A task id. */
  id: string
  /** A2A context id; maps to one deterministic DSH Session. */
  contextId: string
  /** Current lifecycle state. */
  state: TaskState
  /** Epoch milliseconds when the task was accepted. */
  createdAt: number
  /** Epoch milliseconds of the latest transition. */
  updatedAt: number
  /** User and agent messages retained for `tasks/get`. */
  history: Message[]
  /** Concatenated assistant text for the final artifact. */
  outputText: string
  /** Optional status message shown to peers. */
  statusMessage?: Message | undefined
  /** Last failure text, for diagnostics. */
  error?: string | undefined
  /** Configured inbound peer that opened this task, when its token identified one. */
  peer?: string | undefined
  /** Live agent, once the executor attaches it. */
  agent?: Agent | undefined
  /** Deterministic DSH Session id, once the executor attaches it. */
  sessionId?: SessionId | undefined
  /** Pending question while `state === 'input-required'`. */
  pendingQuestion?: PendingQuestion | undefined
  /** Blocking callers waiting for the next settled state. */
  waiters: Set<(task: Task) => void>
  /** Streaming subscribers. */
  subscribers: Set<(event: TaskEvent) => void>
  /** Bounded replay buffer for late subscribers. */
  events: TaskEvent[]
  /** Overall task deadline. */
  timeout?: ReturnType<typeof setTimeout> | undefined
}

/** Input of one send request after protocol normalization. */
export interface SendTaskInput {
  /** User message to deliver. */
  message: Message
  /** Existing task to continue, when the caller named one. */
  taskId?: string
  /** Context to reuse or create. */
  contextId?: string
  /**
   * `continue`: a named task must already exist (0.3 `message.taskId`).
   * `assign`: a named task id is created when absent (0.2 `tasks/send.id`).
   */
  taskIdMode: 'continue' | 'assign'
  /** Maximum history entries returned to the caller. */
  historyLength?: number
  /** Whether the caller waits for input-required or a terminal state. */
  blocking: boolean
}

/** Execution seam implemented by the DSH Agent adapter. */
export interface TaskExecutor {
  /**
   * Drive one task with a user message.
   * @param record - mutable task record.
   * @param message - normalized user message.
   */
  run(record: TaskRecord, message: Message): Promise<void>

  /**
   * Deliver the answer to a pending `input-required` question.
   * @param record - mutable task record.
   * @param message - normalized user message carrying the answer.
   */
  answer(record: TaskRecord, message: Message): Promise<void>

  /**
   * Abort the agent work owned by this task.
   * @param record - mutable task record.
   */
  cancel(record: TaskRecord): void

  /** Release listeners and owned agent handles. */
  dispose(): Promise<void>
}
