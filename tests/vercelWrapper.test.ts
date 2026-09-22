import { EventEmitter } from 'events';
import { describe, it, expect, beforeEach } from 'vitest';
import { primeAuth, resetAll, mockFetch, jsonResponse } from './setup';

const { protectedEndpoint } = await import('../src/apiWrapper');
const { chatSendHandler } = await import('../src/routes/chatSend');

class FakeResponse extends EventEmitter {
  statusCode = 200;
  payload: unknown = null;
  writableEnded = false;
  destroyed = false;
  headers: Record<string, string> = {};

  setHeader(k: string, v: string): this {
    this.headers[k] = v;
    return this;
  }
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
  end(): this {
    this.writableEnded = true;
    this.emit('close');
    return this;
  }
}

function makeReq() {
  const socket = new EventEmitter();
  return {
    method: 'POST',
    headers: {
      'x-forwarded-for': '1.2.3.4',
      authorization: 'Bearer valid-id-token',
    },
    body: { message: 'hi', personality: 'Friend' },
    socket,
    ip: '1.2.3.4',
    user: undefined,
  } as never;
}

beforeEach(() => {
  resetAll();
});

describe('Vercel protectedEndpoint wrapper', () => {
  it('awaits the async route handler and writes the response before resolving', async () => {
    primeAuth('u1');
    mockFetch.mockResolvedValue(jsonResponse({ choices: [{ message: { content: 'hey' } }] }));

    const handler = protectedEndpoint('POST', chatSendHandler);
    const req = makeReq();
    const res = new FakeResponse();

    await handler(req, res);

    // The serverless runtime considers the invocation done when this promise
    // resolves. If the response is not written yet, the response is lost —
    // which is exactly the production bug this guards against.
    expect(res.statusCode).toBe(200);
    expect((res.payload as { reply?: string })?.reply).toBe('hey');
  });

  it('still rejects an unauthenticated request without hanging', async () => {
    const handler = protectedEndpoint('POST', chatSendHandler);
    const req = makeReq();
    (req as { headers: Record<string, string> }).headers.authorization = '';
    const res = new FakeResponse();

    await handler(req, res);

    expect(res.statusCode).toBe(401);
  });
});
