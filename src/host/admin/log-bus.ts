/**
 * Bounded in-memory activity log for the settings panel.
 *
 * The panel polls a snapshot; this bus deliberately keeps no message bodies or
 * credentials, only task identity, direction, state, and a short reason.
 *
 * @module @local/dsh-a2a/admin/log-bus
 */

/** Direction of one activity. */
export type LogDirection = 'inbound' | 'outbound' | 'system'

/** Severity shown by the panel. */
export type LogLevel = 'info' | 'warn' | 'error'

/** One retained activity entry. */
export interface LogEntry {
  seq: number
  time: string
  direction: LogDirection
  level: LogLevel
  message: string
  taskId?: string
  contextId?: string
  peer?: string
  state?: string
  durationMs?: number
}

/** Ring buffer of recent activity. */
export class LogBus {
  private readonly entries: LogEntry[] = []
  private seq = 0

  /**
   * @param capacity - maximum retained entries.
   */
  constructor(private readonly capacity: number) {}

  /**
   * Append one entry, evicting the oldest when at capacity.
   *
   * @param entry - activity without sequence and timestamp.
   */
  record(entry: Omit<LogEntry, 'seq' | 'time'>): void {
    this.seq += 1
    this.entries.push({ seq: this.seq, time: new Date().toISOString(), ...entry })
    if (this.entries.length > this.capacity) this.entries.splice(0, this.entries.length - this.capacity)
  }

  /**
   * Read the newest entries.
   *
   * @param limit - maximum entries to return, newest last.
   * @returns a detached snapshot.
   */
  recent(limit = 50): LogEntry[] {
    return this.entries.slice(-Math.max(0, Math.min(limit, this.capacity)))
  }

  /** Number of retained entries. */
  size(): number {
    return this.entries.length
  }
}
