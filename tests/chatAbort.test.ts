import { EventEmitter } from 'events';
import { describe, it, expect, beforeEach } from 'vitest';
import { primeAuth, resetAll, mockDb, mockFetch, jsonResponse } from './setup';

// Imported after the setup file has installed the firebase-admin / fetch mocks.
const { chatSendHandler } = await import('../src/routes/chatSend');

/**
 * Minimal Express-like response double. `json()` marks the response finished
 * and emits 'close' the way a real response does after it has been written.
 */
class FakeResponse extends EventEmitter {
  statusCode = 200;
  payload: unknown = null;
  writableEnded = false;
  destroyed = false;

  status(code: number): this {
    this.statusCode = code;
    return this;
  }

  json(payload: unknown): this {
    this.payload = payload;
    this.writableEnded = true;
    this.emit('close');
    return this;
  }
}

/** A serverless-style request: `req.socket` is a stream that closes early. */
function makeServerlessRequest(socket: EventEmitter) {
  return {
    user: { uid: 'u1', email: 'u1@test.dev' },
    body: { message: 'hi', personality: 'Friend' },
    headers: { 'x-forwarded-for': '1.2.3.4' },
    socket,
    ip: '1.2.3.4',
  };
}

beforeEach(() => {
  resetAll();
});

describe('chatSendHandler disconnect detection', () => {
  it('still answers when the request socket closes early (serverless runtimes)', async () => {
    primeAuth('u1');
    mockFetch.mockResolvedValue(jsonResponse({ choices: [{ message: { content: 'hey' } }] }));

    const socket = new EventEmitter();
    const req = makeServerlessRequest(socket);
    const res = new FakeResponse();

    const pending = chatSendHandler(req as never, res as never);
    // Vercel/Lambda: the synthetic request socket emits 'close' as soon as the
    // body is consumed. This must NOT be treated as a client disconnect.
    socket.emit('close');
    await pending;

    expect(res.statusCode).toBe(200);
    expect((res.payload as { reply?: string }).reply).toBe('hey');
    // Quota consumed exactly once, like a normal successful reply.
    expect(mockDb.get('subscriptions/u1')?.messageCount).toBe(1);
  });

  it('does not abort on the response close that follows a written response', async () => {
    primeAuth('u1');
    mockFetch.mockResolvedValue(jsonResponse({ choices: [{ message: { content: 'ok' } }] }));

    const res = new FakeResponse();
    await chatSendHandler(makeServerlessRequest(new EventEmitter()) as never, res as never);

    expect(res.statusCode).toBe(200);
    expect((res.payload as { reply?: string }).reply).toBe('ok');
  });

  it('skips the AI call and consumes no quota when the response truly closes early', async () => {
    primeAuth('u1');

    const res = new FakeResponse();
    const req = makeServerlessRequest(new EventEmitter());

    const pending = chatSendHandler(req as never, res as never);
    // The client genuinely hangs up before a reply exists: the response
    // closes while still unwritten, so the AI call is abandoned.
    res.emit('close');
    await pending;

    // No reply is delivered and no quota is burned for a reply nobody saw.
    expect(res.payload).toBeNull();
    expect(mockDb.get('subscriptions/u1')).toBeUndefined();
  });
});
