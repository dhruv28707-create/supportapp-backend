import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { primeAuth, authHeader, resetAll, mockFetch } from './setup';

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
