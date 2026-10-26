import { Request, Response } from 'express';
import crypto from 'crypto';
import zlib from 'zlib';
import { logAppEvent, AppLogLevel } from '../services/logService';
import { timingSafeEqualHex } from '../utils/crypto';

/**
 * Receiver for Vercel Log Drains (Pro/Enterprise feature). Configure a custom
 * drain in the Vercel dashboard pointing at this URL with the JSON or NDJSON
 * format, and set:
 *   VERCEL_LOG_DRAIN_ENABLED=true
 *   VERCEL_LOG_DRAIN_SECRET=<the drain's signature secret (>=32 chars)>
 *
 * Vercel delivers batched runtime logs as an HMAC-SHA1-signed POST (hex
 * digest of the raw body in `x-vercel-signature`), optionally gzip-encoded.
 * The one-time setup probe is unsigned and only requires echoing back the
 * `x-vercel-verify` header.
 *
 * Received lines are stored as `vercel_log` appLog events so they appear in
 * the same read-only logs endpoint as the app's structured events. Message
 * text is truncated by logService; `[logs] ...` lines are skipped so a log
 * write failure can never feed back into itself.
 */

const MAX_ENTRIES_PER_REQUEST = 200;
const MAX_RAW_BODY_BYTES = 2 * 1024 * 1024; // Vercel batches up to ~1MB

interface VercelLogEntry {
  id?: unknown;
  message?: unknown;
  level?: unknown;
  source?: unknown;
  environment?: unknown;
  projectId?: unknown;
  deploymentId?: unknown;
  timestamp?: unknown;
  statusCode?: unknown;
}

/** Parses a JSON array or newline-delimited JSON batch into log objects. */
function parseDrainPayload(text: string): VercelLogEntry[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  const asArray = parseJsonSlice(trimmed);
  if (asArray && Array.isArray(asArray)) {
    return asArray.filter((entry): entry is VercelLogEntry => !!entry && typeof entry === 'object');
  }

  const entries: VercelLogEntry[] = [];
  for (const line of trimmed.split('\n')) {
    const parsed = parseJsonSlice(line.trim());
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      // All VercelLogEntry fields are optional, so a plain parsed object is
      // assignable; individual fields are guarded again when read below.
      entries.push(parsed);
    }
  }
  return entries;
}

function parseJsonSlice(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function normalizeLevel(raw: unknown): AppLogLevel {
  if (raw === 'warn' || raw === 'warning') return 'warn';
  if (raw === 'error' || raw === 'fatal') return 'error';
  return 'info';
}

/** Vercel `level` strings and our own console prefixes both map here. */
function inferLevel(entry: VercelLogEntry): AppLogLevel {
  const explicit = normalizeLevel(entry.level);
  if (explicit !== 'info') return explicit;
  if (typeof entry.message === 'string' && entry.message.includes('[error]')) return 'error';
  return 'info';
}

export async function vercelLogDrainHandler(req: Request, res: Response): Promise<void> {
  const secret = process.env.VERCEL_LOG_DRAIN_SECRET || '';
  const enabled = process.env.VERCEL_LOG_DRAIN_ENABLED !== 'false';
  if (!enabled || !secret) {
    // Drain not configured: refuse rather than accept unauthenticated writes.
    res.status(503).json({ error: 'Log drain not configured' });
    return;
  }

  // One-time setup probe: unsigned; echo the verify code back as a header.
  const verify = req.headers['x-vercel-verify'];
  if (typeof verify === 'string' && verify) {
    res.setHeader('x-vercel-verify', verify);
    res.status(200).end();
    return;
  }

  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body ?? ''));
  if (raw.length > MAX_RAW_BODY_BYTES) {
    res.status(413).json({ error: 'Payload too large' });
    return;
  }

  const signature = req.headers['x-vercel-signature'];
  if (typeof signature !== 'string' || !signature) {
    res.status(403).json({ error: 'Missing signature' });
    return;
  }
  const expected = crypto.createHmac('sha1', secret).update(raw).digest('hex');
  if (!timingSafeEqualHex(expected, signature.toLowerCase())) {
    res.status(403).json({ error: 'Invalid signature' });
    return;
  }

  let bodyText: string;
  try {
    bodyText =
      req.headers['content-encoding'] === 'gzip'
        ? zlib.gunzipSync(raw).toString('utf8')
        : raw.toString('utf8');
  } catch {
    res.status(400).json({ error: 'Unsupported content-encoding' });
    return;
  }

  const entries = parseDrainPayload(bodyText);
  if (entries.length === 0) {
    res.status(400).json({ error: 'No log entries found' });
    return;
  }

  let stored = 0;
  for (const entry of entries.slice(0, MAX_ENTRIES_PER_REQUEST)) {
    const message = typeof entry.message === 'string' ? entry.message : String(entry.id ?? '');
    // Feedback-loop guard: never store our own log-service console lines.
    if (message.startsWith('[logs]')) continue;
    const vercelTs =
      typeof entry.timestamp === 'number' && Number.isFinite(entry.timestamp)
        ? entry.timestamp
        : null;
    logAppEvent({
      event: 'vercel_log',
      level: inferLevel(entry),
      route: typeof entry.source === 'string' ? entry.source : undefined,
      status: typeof entry.statusCode === 'number' ? entry.statusCode : undefined,
      detail: {
        message: message || null,
        vercelTs,
        environment: typeof entry.environment === 'string' ? entry.environment : null,
        deploymentId: typeof entry.deploymentId === 'string' ? entry.deploymentId : null,
        projectId: typeof entry.projectId === 'string' ? entry.projectId : null,
      },
    });
    stored += 1;
  }

  res.json({ ok: true, received: entries.length, stored });
}
