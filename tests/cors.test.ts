import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { resetAll } from './setup';

const { createApp } = await import('../src/app');
const { enforceCors } = await import('../src/config/cors');

const app = createApp();

function fakeRes() {
  const headers: Record<string, string> = {};
  return {
    headers,
    statusCode: 200,
    payload: null as unknown,
    setHeader(key: string, value: string) {
      headers[key.toLowerCase()] = value;
      return this;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.payload = payload;
      return this;
    },
  };
}

beforeEach(() => {
  resetAll();
});

describe('CORS', () => {
  it('rejects a disallowed browser origin in the Express app (403)', async () => {
    const res = await request(app)
      .get('/api/health')
      .set('Origin', 'https://evil.example');

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Origin not allowed');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('allows a configured origin and reflects it', async () => {
    const res = await request(app)
      .get('/api/health')
      .set('Origin', 'http://localhost:3000');

    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:3000');
  });

  it('Vercel wrapper rejects a disallowed origin before the handler runs', () => {
    const res = fakeRes();
    const allowed = enforceCors(
      { headers: { origin: 'https://evil.example' } } as never,
      res as never
    );

    expect(allowed).toBe(false);
    expect(res.statusCode).toBe(403);
    expect(res.payload).toMatchObject({ error: 'Origin not allowed' });
  });

  it('Vercel wrapper allows a configured origin and no-Origin requests', () => {
    const allowedRes = fakeRes();
    expect(
      enforceCors({ headers: { origin: 'http://localhost:5173' } } as never, allowedRes as never)
    ).toBe(true);
    expect(allowedRes.headers['access-control-allow-origin']).toBe('http://localhost:5173');

    expect(enforceCors({ headers: {} } as never, fakeRes() as never)).toBe(true);
  });
});
