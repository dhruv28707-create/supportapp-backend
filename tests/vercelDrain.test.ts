import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';
import zlib from 'zlib';
import {
  mockDb,
  resetAll,
} from './setup';

const { createApp } = await import('../src/app');

const app = createApp();

const DRAIN_SECRET = 'drain-secret-0123456789abcdef0123456789abcdef';

function ndjson(lines: object[]): string {
  return lines.map((line) => JSON.stringify(line)).join('\n');
}

/** Signs the raw body exactly like Vercel: HMAC-SHA1 hex digest. */
function vercelSignature(raw: string, secret = DRAIN_SECRET): string {
  return crypto.createHmac('sha1', secret).update(Buffer.from(raw)).digest('hex');
}

function drainPost(body: string, extraHeaders: Record<string, string> = {}) {
  return request(app)
    .post('/api/logs/vercel')
    .set('Content-Type', 'application/x-ndjson')
    .set(extraHeaders)
    .send(Buffer.from(body));
}

describe('vercel log drain receiver', () => {
  beforeEach(() => {
    resetAll();
  });

  it('is closed when no drain secret is configured', async () => {
    const res = await drainPost(ndjson([{ message: 'hello' }]));
    expect(res.status).toBe(503);
  });

  it('echoes x-vercel-verify on the unsigned setup probe', async () => {
    vi.stubEnv('VERCEL_LOG_DRAIN_SECRET', DRAIN_SECRET);
    const res = await request(app)
      .post('/api/logs/vercel')
      .set('x-vercel-verify', 'verify-code-123')
      .send('');
    expect(res.status).toBe(200);
    expect(res.headers['x-vercel-verify']).toBe('verify-code-123');
  });

  it('rejects deliveries without or with a wrong signature', async () => {
    vi.stubEnv('VERCEL_LOG_DRAIN_SECRET', DRAIN_SECRET);
    const body = ndjson([{ message: 'line' }]);

    const missing = await drainPost(body);
    expect(missing.status).toBe(403);

    const wrong = await drainPost(body, { 'x-vercel-signature': 'deadbeef' });
    expect(wrong.status).toBe(403);
    expect(mockDb.paths().some((path) => path.startsWith('appLogs/'))).toBe(false);
  });

  it('stores signed NDJSON batches as vercel_log events', async () => {
    vi.stubEnv('VERCEL_LOG_DRAIN_SECRET', DRAIN_SECRET);
    const body = ndjson([
      { id: '1', message: '[chat uid=abcd1234] Reply served by groq', source: 'lambda', level: 'info', timestamp: 1573817187330, deploymentId: 'dpl_1' },
      { id: '2', message: 'Payment verify error: boom', source: 'lambda', level: 'error', timestamp: 1573817187331 },
    ]);
    const res = await drainPost(body, { 'x-vercel-signature': vercelSignature(body) });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, received: 2, stored: 2 });

    const stored = mockDb.docsIn('appLogs').map((doc) => doc.data);
    const drained = stored.filter((data) => data.event === 'vercel_log');
    expect(drained).toHaveLength(2);
    // Entry level/source mapping and vercel timestamp passthrough.
    expect(drained.some((data) => data.level === 'error' && data.route === 'lambda')).toBe(true);
    expect(drained.every((data) => (data.detail as { vercelTs: number | null }).vercelTs === 1573817187330 ||
      (data.detail as { vercelTs: number | null }).vercelTs === 1573817187331)).toBe(true);

    // Feedback guard: log-service console lines are never stored.
    const guarded = ndjson([{ id: '3', message: '[logs] App log write failed: x' }]);
    await drainPost(guarded, { 'x-vercel-signature': vercelSignature(guarded) });
    const after = mockDb.docsIn('appLogs').map((doc) => doc.data);
    expect(after.filter((data) => data.event === 'vercel_log')).toHaveLength(2);
  });

  it('accepts the JSON array format and caps batch size', async () => {
    vi.stubEnv('VERCEL_LOG_DRAIN_SECRET', DRAIN_SECRET);
    const many = Array.from({ length: 260 }, (_, index) => ({ id: String(index), message: `line ${index}` }));
    const res = await drainPost(JSON.stringify(many), {
      'x-vercel-signature': vercelSignature(JSON.stringify(many)),
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ received: 260, stored: 200 });

    const drained = mockDb.docsIn('appLogs').filter(
      (doc) => doc.data.event === 'vercel_log'
    );
    expect(drained).toHaveLength(200);
  });

  it('accepts gzip-encoded deliveries (signature verified on the compressed bytes)', async () => {
    vi.stubEnv('VERCEL_LOG_DRAIN_SECRET', DRAIN_SECRET);
    const text = ndjson([{ message: 'gzipped hello' }, { message: 'second line' }]);
    const compressed = zlib.gzipSync(Buffer.from(text));

    const res = await request(app)
      .post('/api/logs/vercel')
      .set('Content-Type', 'application/x-ndjson')
      .set('Content-Encoding', 'gzip')
      .set('x-vercel-signature', crypto.createHmac('sha1', DRAIN_SECRET).update(compressed).digest('hex'))
      .send(compressed);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, received: 2, stored: 2 });
    const drained = mockDb.docsIn('appLogs').filter((doc) => doc.data.event === 'vercel_log');
    expect(drained).toHaveLength(2);
  });

  it('rejects a decompression bomb instead of OOMing (hard output cap)', async () => {
    vi.stubEnv('VERCEL_LOG_DRAIN_SECRET', DRAIN_SECRET);
    // Tiny compressed payload that expands far beyond every cap.
    const bomb = zlib.gzipSync(Buffer.alloc(64 * 1024 * 1024, 0));
    expect(bomb.length).toBeLessThan(2 * 1024 * 1024);

    const res = await request(app)
      .post('/api/logs/vercel')
      .set('Content-Type', 'application/x-ndjson')
      .set('Content-Encoding', 'gzip')
      .set('x-vercel-signature', crypto.createHmac('sha1', DRAIN_SECRET).update(bomb).digest('hex'))
      .send(bomb);

    expect(res.status).toBe(413);
    expect(
      mockDb.docsIn('appLogs').filter((doc) => doc.data.event === 'vercel_log')
    ).toHaveLength(0);
  });

  it('rejects corrupt gzip payloads with 400', async () => {
    vi.stubEnv('VERCEL_LOG_DRAIN_SECRET', DRAIN_SECRET);
    const garbage = Buffer.from('definitely-not-gzip-data');
    const res = await request(app)
      .post('/api/logs/vercel')
      .set('Content-Type', 'application/x-ndjson')
      .set('Content-Encoding', 'gzip')
      .set('x-vercel-signature', crypto.createHmac('sha1', DRAIN_SECRET).update(garbage).digest('hex'))
      .send(garbage);

    expect(res.status).toBe(400);
  });

  it('rejects unsupported content-encoding values with 415', async () => {
    vi.stubEnv('VERCEL_LOG_DRAIN_SECRET', DRAIN_SECRET);
    const body = ndjson([{ message: 'hello' }]);
    const res = await request(app)
      .post('/api/logs/vercel')
      .set('Content-Type', 'application/x-ndjson')
      .set('Content-Encoding', 'bogus-encoding')
      .set('x-vercel-signature', vercelSignature(body))
      .send(Buffer.from(body));

    expect(res.status).toBe(415);
  });
});
