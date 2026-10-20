import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { primeAuth, authHeader, resetAll, mockFetch, mockDb } from './setup';

const { createApp } = await import('../src/app');
const app = createApp();

beforeEach(() => {
  resetAll();
});

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  async function* gen() {
    for (const c of chunks) yield encoder.encode(c);
  }
  return {
    ok: true,
    status: 200,
    json: async () => ({}),
    body: gen(),
  } as unknown as Response;
}

describe('streaming smoke', () => {
  it('streams tokens then done event with quota consumed', async () => {
    primeAuth('u1');
    mockFetch.mockResolvedValue(
      sseResponse([
        'data: {"choices":[{"delta":{"content":"hel"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
        'data: [DONE]\n\n',
      ])
    );
    const res = await request(app)
      .post('/api/chat?stream=1')
      .set(authHeader())
      .set('Accept', 'text/event-stream')
      .send({ message: 'hi', personality: 'Friend' });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.text).toContain('"token":"hel"');
    expect(res.text).toContain('"token":"lo"');
    expect(res.text).toContain('"done":true');
    expect(res.text).toContain('hello');
    expect(res.text).toContain('[DONE]');
    // Quota accounting rides in the background after the stream ends.
    await vi.waitFor(() => {
      expect(mockDb.get('subscriptions/u1')?.messageCount).toBe(1);
    });
  });

  it('does not forward a control token split across streamed chunks', async () => {
    primeAuth('u1');
    mockFetch.mockResolvedValue(
      sseResponse([
        'data: {"choices":[{"delta":{"content":"Baki sab kaam"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":" ho jayega.<|end"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"oftext|>Okay! Morse code?"}}]}\n\n',
      ])
    );

    const res = await request(app)
      .post('/api/chat?stream=1')
      .set(authHeader())
      .send({ message: 'Fir baki sab manage kese hoga', personality: 'Father' });

    expect(res.status).toBe(200);
    expect(res.text).toContain('Baki sab kaam ho jayega.');
    expect(res.text).not.toContain('<|endoftext|>');
    expect(res.text).not.toContain('Morse code');
  });

  it('sends error event when all providers fail', async () => {
    primeAuth('u1');
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: { message: 'down' } }),
      body: null,
    } as unknown as Response);
    const res = await request(app)
      .post('/api/chat?stream=1')
      .set(authHeader())
      .send({ message: 'hi', personality: 'Friend' });
    expect(res.status).toBe(200);
    expect(res.text).toContain('ai_upstream_error');
  });
});
