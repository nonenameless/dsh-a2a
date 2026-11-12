import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { Config, resolveConfig } from '../../src/host/config.ts'
import { AgentExecutor } from '../../src/host/inbound/agent-executor.ts'
import { TaskManager } from '../../src/host/inbound/task-manager.ts'
import type { SendTaskInput } from '../../src/host/inbound/task-types.ts'
import { textPart, type Task } from '../../src/shared/protocol.ts'

/** Configuration with a long deadline. */
const config = resolveConfig(Config({ server: { timeoutMs: 60_000 } }))

/** Let fire-and-forget agent work reach its first await. */
function tick(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0))
}

/** One fake agent + the capturing agents service. */
function harness() {
  const ctx = new Context()
  const agentCtx = new Context()
  let createdSessionId = SessionId('unset')
  let followups = 0
  let cancelCount = 0
  let questionAnswer: unknown
  let questionAnswered = false

  const agent = {
    id: createdSessionId,
    session: { id: createdSessionId },
    ctx: agentCtx,
    followup: () => { followups += 1 },
    cancel: () => { cancelCount += 1 },
  }

  const agents = {
    get: () => undefined,
    create: async (options: { sessionId: SessionId }) => {
      createdSessionId = options.sessionId
      agent.id = createdSessionId
      agent.session.id = createdSessionId
      return { agent, dispose: async () => {} }
    },
    resume: async () => ({ agent, dispose: async () => {} }),
  }

  ctx.provide('agents', agents as never)
  ctx.provide('agentDefaultModel', {
    currentSelection: () => ({ provider: 'test', model: 'test-model' }),
  } as never)

  const executor = new AgentExecutor(ctx, config)
  const manager = new TaskManager(config, executor)
  executor.bindSink(manager)

  const emit = (event: unknown): void => {
    ctx.emit('session/event', { id: createdSessionId } as never, event as never)
  }

  return {
    ctx,
    agentCtx,
    executor,
    manager,
    agent,
    emit,
    get followups() { return followups },
    get cancelCount() { return cancelCount },
    get sessionId() { return createdSessionId },
    get questionAnswer() { return questionAnswer },
    get questionAnswered() { return questionAnswered },
    setQuestionAnswered(value: unknown) { questionAnswer = value; questionAnswered = true },
  }
}

/** Send one blocking task. */
function send(manager: TaskManager, text: string, extra: Partial<SendTaskInput> = {}): Promise<Task> {
  return manager.send({
    message: { kind: 'message', messageId: `m-${text}`, role: 'user', parts: [textPart(text)] },
    taskIdMode: 'continue',
    blocking: true,
    ...extra,
  })
}

describe('agent executor', () => {
  it('creates one agent per context and completes on turn end', async () => {
    const h = harness()
    const pending = send(h.manager, 'hello')
    await tick()

    expect(h.followups).toBe(1)
    expect(String(h.sessionId)).toMatch(/^a2a-[0-9a-f]{32}$/)

    h.emit({
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: 'hello back' }] } },
    })
    h.emit({ type: 'turn/end', data: { reason: { kind: 'completed' } } })

    const task = await pending
    expect(task.status.state).toBe('completed')
    expect(task.artifacts?.[0]?.parts).toEqual([{ kind: 'text', text: 'hello back' }])
  })

  it('parks a user question as input-required and continues it', async () => {
    const h = harness()
    h.agent.followup = () => {
      void h.agentCtx.waterfall(
        'user-questions/request',
        {
          questions: [{
            id: 'q1',
            question: 'Proceed?',
            options: [{ label: 'Yes' }, { label: 'No' }],
          }],
        } as never,
        async () => { throw new Error('no answerer') },
      ).then(answer => { h.setQuestionAnswered(answer) })
    }

    const first = await send(h.manager, 'start')
    expect(first.status.state).toBe('input-required')

    const second = send(h.manager, 'Yes', { contextId: first.contextId })
    await tick()
    expect(h.questionAnswered).toBe(true)
    expect(h.questionAnswer).toMatchObject({ answers: [{ id: 'q1', selected: ['Yes'] }] })

    h.emit({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
    const completed = await second
    expect(completed.status.state).toBe('completed')
  })

  it('cancels the live agent when the task is canceled', async () => {
    const h = harness()
    const task = await h.manager.send({
      message: { kind: 'message', messageId: 'm-cancel', role: 'user', parts: [textPart('wait')] },
      taskIdMode: 'continue',
      blocking: false,
    })
    await tick()
    h.manager.cancel(task.id)
    expect(h.cancelCount).toBe(1)
  })
})
