import { afterEach, describe, expect, it } from 'vitest'
import { Config, resolveConfig } from '../../src/host/config.ts'
import { A2A_ERROR, textPart, type Message, type Task } from '../../src/shared/protocol.ts'
import { TaskManager } from '../../src/host/inbound/task-manager.ts'
import type { PendingQuestion, SendTaskInput, TaskExecutor, TaskRecord } from '../../src/host/inbound/task-types.ts'

/** Configuration with a long deadline so tests never race the timer. */
const config = resolveConfig(Config({ server: { timeoutMs: 60_000 } }))

/** Build one user message. */
function userMessage(text: string, taskId?: string, contextId?: string): Message {
  return {
    kind: 'message',
    messageId: `m-${Math.random().toString(36).slice(2)}`,
    role: 'user',
    parts: [textPart(text)],
    ...taskId === undefined ? {} : { taskId },
    ...contextId === undefined ? {} : { contextId },
  }
}

/** Executor whose behavior each test supplies. */
class FakeExecutor implements TaskExecutor {
  runImpl: (record: TaskRecord, message: Message) => void = () => {}
  answerImpl: (record: TaskRecord, message: Message) => void = () => {}
  readonly canceled: string[] = []

  async run(record: TaskRecord, message: Message): Promise<void> {
    this.runImpl(record, message)
  }

  async answer(record: TaskRecord, message: Message): Promise<void> {
    this.answerImpl(record, message)
  }

  cancel(record: TaskRecord): void {
    this.canceled.push(record.id)
  }

  async dispose(): Promise<void> {}
}

const managers: TaskManager[] = []

/** Create a manager that is disposed after the test. */
function manager(executor: TaskExecutor): TaskManager {
  const created = new TaskManager(config, executor)
  managers.push(created)
  return created
}

/** Send one blocking task. */
function send(taskManager: TaskManager, text: string, extra: Partial<SendTaskInput> = {}): Promise<Task> {
  return taskManager.send({
    message: userMessage(text),
    taskIdMode: 'continue',
    blocking: true,
    ...extra,
  })
}

/** Let a fire-and-forget executor start. */
function tick(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0))
}

afterEach(async () => {
  await Promise.all(managers.splice(0).map(async item => item.dispose()))
})

describe('task manager', () => {
  it('runs a task to completion and returns the artifact', async () => {
    const executor = new FakeExecutor()
    const taskManager = manager(executor)
    executor.runImpl = (record) => {
      taskManager.appendText(record, 'hello')
      taskManager.complete(record)
    }

    const task = await send(taskManager, 'hi')
    expect(task.status.state).toBe('completed')
    expect(task.artifacts?.[0]?.parts).toEqual([{ kind: 'text', text: 'hello' }])
    expect(task.history?.some(message => message.role === 'agent')).toBe(true)
  })

  it('parks a question as input-required and continues it', async () => {
    const executor = new FakeExecutor()
    const taskManager = manager(executor)
    let deferred: PendingQuestion | undefined

    executor.runImpl = (record) => {
      let resolveAnswer!: (value: { answers: Array<{ id: string; selected: string[] }> }) => void
      let rejectAnswer!: (error: Error) => void
      const answer = new Promise<{ answers: Array<{ id: string; selected: string[] }> }>((resolve, reject) => {
        resolveAnswer = resolve
        rejectAnswer = reject
      })
      const question: PendingQuestion = {
        request: { questions: [{ id: 'q1', question: 'Proceed?' }] },
        resolve: resolveAnswer,
        reject: rejectAnswer,
      }
      deferred = question
      void answer.then(() => {
        taskManager.appendText(record, 'done')
        taskManager.complete(record)
      })
      taskManager.markInputRequired(record, question.request, question)
    }

    const first = await send(taskManager, 'start')
    expect(first.status.state).toBe('input-required')
    expect(first.status.message?.parts.some(part => part.kind === 'data')).toBe(true)

    executor.answerImpl = () => { deferred?.resolve({ answers: [{ id: 'q1', selected: ['yes'] }] }) }
    const second = await taskManager.send({
      message: userMessage('yes', undefined, first.contextId),
      contextId: first.contextId,
      taskIdMode: 'continue',
      blocking: true,
    })
    expect(second.status.state).toBe('completed')
    expect(second.artifacts?.[0]?.parts).toEqual([{ kind: 'text', text: 'done' }])
  })

  it('reports task-not-found and rejects a terminal continuation', async () => {
    const executor = new FakeExecutor()
    const taskManager = manager(executor)
    executor.runImpl = (record) => { taskManager.appendText(record, 'ok'); taskManager.complete(record) }

    const task = await send(taskManager, 'hi')
    expect(() => taskManager.get('missing')).toThrow(expect.objectContaining({ code: A2A_ERROR.taskNotFound }))
    await expect(taskManager.send({
      message: userMessage('again', task.id, task.contextId),
      taskId: task.id,
      taskIdMode: 'continue',
      blocking: true,
    })).rejects.toMatchObject({ code: A2A_ERROR.invalidRequest })
  })

  it('rejects a second send to a task that is still working', async () => {
    const executor = new FakeExecutor()
    const taskManager = manager(executor)
    let taskId = ''
    executor.runImpl = (record) => { taskId = record.id }
    const pending = send(taskManager, 'first')
    await tick()

    await expect(taskManager.send({
      message: userMessage('second', taskId),
      taskId,
      taskIdMode: 'continue',
      blocking: true,
    })).rejects.toMatchObject({ code: A2A_ERROR.invalidRequest })
    taskManager.cancel(taskId)
    await pending
  })

  it('replays status and artifact events to a late subscriber', async () => {
    const executor = new FakeExecutor()
    const taskManager = manager(executor)
    executor.runImpl = (record) => { taskManager.appendText(record, 'streamed'); taskManager.complete(record) }

    const task = await send(taskManager, 'hi')
    const events: string[] = []
    const dispose = taskManager.subscribe(task.id, event => {
      events.push(event.kind === 'status-update' ? `status:${event.status.state}` : 'artifact')
    }, true)
    dispose()

    expect(events).toEqual(['status:completed', 'artifact'])
  })

  it('cancels a running task and resolves its blocking caller', async () => {
    const executor = new FakeExecutor()
    const taskManager = manager(executor)
    let taskId = ''
    executor.runImpl = (record) => { taskId = record.id }
    const pending = send(taskManager, 'wait')
    await tick()

    const canceled = taskManager.cancel(taskId)
    expect(canceled.status.state).toBe('canceled')
    expect(executor.canceled).toContain(taskId)
    await expect(pending).resolves.toMatchObject({ status: { state: 'canceled' } })
  })
})
