/**
 * Pure A2A task state machine.
 *
 * The six core states are always available; 0.3 additions (`rejected`,
 * `auth-required`) are accepted too. Every mutation goes through
 * {@link assertTransition}, so an illegal sequence fails at its source instead
 * of producing a task whose history and status disagree.
 *
 * @module @local/dsh-a2a/inbound/task-machine
 */

import { A2A_ERROR, isTerminalState, type TaskState } from '../../shared/protocol.ts'
import { A2AProtocolError } from '../../shared/errors.ts'

/** Legal destination states for each source state. */
const TRANSITIONS: Readonly<Record<TaskState, ReadonlySet<TaskState>>> = {
  submitted: new Set<TaskState>(['working', 'canceled', 'failed']),
  working: new Set<TaskState>(['input-required', 'completed', 'canceled', 'failed']),
  'input-required': new Set<TaskState>(['working', 'completed', 'canceled', 'failed']),
  completed: new Set<TaskState>(),
  canceled: new Set<TaskState>(),
  failed: new Set<TaskState>(),
  rejected: new Set<TaskState>(),
  'auth-required': new Set<TaskState>(['working', 'canceled', 'failed']),
  unknown: new Set<TaskState>(),
}

/**
 * Whether one transition is legal.
 *
 * @param from - current state.
 * @param to - proposed state.
 * @returns true when the machine admits the transition.
 */
export function canTransition(from: TaskState, to: TaskState): boolean {
  return TRANSITIONS[from].has(to)
}

/**
 * Assert one legal transition.
 *
 * @param from - current state.
 * @param to - proposed state.
 * @throws {A2AProtocolError} with `-32600` when the transition is illegal.
 */
export function assertTransition(from: TaskState, to: TaskState): void {
  if (canTransition(from, to)) return
  throw new A2AProtocolError(
    A2A_ERROR.invalidRequest,
    `Illegal task transition: ${from} → ${to}`,
    { from, to },
  )
}

/** Re-exported for callers that only need the terminal predicate. */
export { isTerminalState }
