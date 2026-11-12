import { describe, expect, it } from 'vitest'
import { dataPart, textPart, type Message } from '../../src/shared/protocol.ts'
import { answerFromMessage } from '../../src/host/inbound/agent-executor.ts'

/** Build one user answer message. */
function message(parts: Message['parts']): Message {
  return { kind: 'message', messageId: 'm-1', role: 'user', parts }
}

describe('question answer mapping', () => {
  it('matches an option label from plain text', () => {
    const answer = answerFromMessage(message([textPart('Approve')]), [
      { id: 'q1', question: 'Proceed?', options: [{ label: 'Approve' }, { label: 'Reject' }] },
    ])
    expect(answer).toEqual({ answers: [{ id: 'q1', selected: ['Approve'] }] })
  })

  it('matches multiple comma-separated options', () => {
    const answer = answerFromMessage(message([textPart('One, Three')]), [
      { id: 'q1', question: 'Pick', multiSelect: true, options: [{ label: 'One' }, { label: 'Two' }, { label: 'Three' }] },
    ])
    expect(answer.answers[0]?.selected).toEqual(['One', 'Three'])
  })

  it('falls back to the reject option for an unmatched approval', () => {
    const answer = answerFromMessage(message([textPart('what?')]), [
      { id: 'q1', question: 'Allow?', intent: { kind: 'approval', approve: 'Allow', reject: 'Deny' }, options: [{ label: 'Allow' }, { label: 'Deny' }] },
    ])
    expect(answer.answers[0]).toEqual({ id: 'q1', selected: ['Deny'], custom: 'what?' })
  })

  it('uses a structured answers data part when present', () => {
    const answer = answerFromMessage(message([dataPart({
      answers: [{ id: 'q1', selected: ['A'], custom: 'because' }],
    })]), [{ id: 'q1', question: 'Pick', options: [{ label: 'A' }] }])
    expect(answer).toEqual({ answers: [{ id: 'q1', selected: ['A'], custom: 'because' }] })
  })
})
