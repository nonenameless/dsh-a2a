import { describe, expect, it } from 'vitest'
import { parseSseStream, type SseFrame } from '../../src/host/outbound/sse-parser.ts'

/** Build one byte stream that emits the text in fixed-size chunks. */
function stream(text: string, chunkSize = 7): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text)
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        controller.enqueue(bytes.slice(offset, offset + chunkSize))
      }
      controller.close()
    },
  })
}

/** Collect every parsed frame. */
async function parse(text: string, chunkSize = 7): Promise<SseFrame[]> {
  const frames: SseFrame[] = []
  for await (const frame of parseSseStream(stream(text, chunkSize))) frames.push(frame)
  return frames
}

describe('SSE parser', () => {
  it('parses data, event, id, and retry fields', async () => {
    expect(await parse('event: status\ndata: {"a":1}\nid: 7\nretry: 1500\n\n')).toEqual([
      { event: 'status', data: '{"a":1}', id: '7', retry: 1500 },
    ])
  })

  it('joins multi-line data and ignores comments', async () => {
    expect(await parse(': keepalive\ndata: first\ndata: second\n\n')).toEqual([{ data: 'first\nsecond' }])
  })

  it('handles CRLF framing across chunk boundaries', async () => {
    expect(await parse('data: one\r\n\r\ndata: two\r\n\r\n', 3)).toEqual([{ data: 'one' }, { data: 'two' }])
  })

  it('flushes a final frame without a trailing blank line', async () => {
    expect(await parse('data: tail')).toEqual([{ data: 'tail' }])
  })

  it('ignores comment-only and field-less frames', async () => {
    expect(await parse(': comment\n\n\n\n')).toEqual([])
  })
})
