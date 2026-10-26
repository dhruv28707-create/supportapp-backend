import { randomUUID } from 'crypto';
import { db } from '../config/firebaseAdmin';

/**
 * Firestore-backed application event log, browsable through the read-only
 * developer API (`GET /api/developer/logs`). Vercel's runtime log stream is
 * ephemeral and console-only, so key operational events (chat outcomes,
 * upstream failures, quota, payments, trials, deletions) are also persisted
 * here, best-effort.
 *
 * Never log message content, prompt text, or secrets. Detail values must be
 * JSON-safe primitives; strings are truncated to a hard cap.
 */

export const APP_LOGS_COLLECTION = 'appLogs';

/** How long log docs live (for a Firestore TTL policy on `expiresAt`). */
const APP_LOG_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Hard cap on any string written into `detail`. */
const MAX_DETAIL_STRING_LENGTH = 500;

// Monotonic timestamp source: two events in the same wall-clock millisecond
// would collide on the `ts` cursor and paginate incorrectly (startAfter is
// exclusive), so guarantees strictly increasing values.
let lastLogTs = 0;
function nextLogTs(): number {
  const now = Date.now();
  lastLogTs = Math.max(now, lastLogTs + 1);
  return lastLogTs;
}

export type AppLogLevel = 'info' | 'warn' | 'error';

export interface AppLogEntry {
  /** Stable event name, e.g. `chat_reply`, `payment_order_created`. */
  event: string;
  level?: AppLogLevel;
  /** Full uid of the acting user (for filtering); omitted when unknown. */
  uid?: string | null;
  route?: string;
  /** HTTP status returned to the client, when applicable. */
  status?: number;
  durationMs?: number;
  /** JSON-safe primitives only. */
  detail?: Record<string, unknown>;
}

function sanitizeDetailValue(value: unknown, depth: number): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    return value.length > MAX_DETAIL_STRING_LENGTH
      ? `${value.slice(0, MAX_DETAIL_STRING_LENGTH)}...`
      : value;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'object') return `[${typeof value}]`;
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => sanitizeDetailValue(item, depth - 1));
  }
  if (value instanceof Date) return value.toISOString();
  if (depth <= 0) return '[object]';
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>).slice(0, 20)) {
    out[key] = sanitizeDetailValue(entry, depth - 1);
  }
  return out;
}

/**
 * Writes one event to `appLogs`. Never throws; resolves once persisted.
 * Writes are disabled entirely when APP_LOGS_ENABLED=false (e.g. to cut
 * Firestore write volume in emergencies).
 */
export async function writeAppLog(entry: AppLogEntry): Promise<void> {
  if (process.env.APP_LOGS_ENABLED === 'false') return;

  const level: AppLogLevel = entry.level ?? 'info';
  const now = nextLogTs();
  const payload: Record<string, unknown> = {
    ts: now,
    expiresAt: new Date(now + APP_LOG_TTL_MS),
    level,
    event: entry.event,
  };
  if (entry.uid) payload.uid = entry.uid;
  if (entry.route) payload.route = entry.route;
  if (typeof entry.status === 'number') payload.status = entry.status;
  if (typeof entry.durationMs === 'number') payload.durationMs = entry.durationMs;
  if (entry.detail) payload.detail = sanitizeDetailValue(entry.detail, 2);

  try {
    await db
      .collection(APP_LOGS_COLLECTION)
      .doc(`log_${now}_${randomUUID().slice(0, 8)}`)
      .set(payload, { merge: false });
  } catch (error) {
    console.error('[logs] App log write failed:', error);
  }
}

/**
 * Fire-and-forget variant for the response hot path: never delays a reply.
 * On serverless an unawaited write can be dropped after the response, so
 * prefer `await writeAppLog(...)` for pre-response failure events.
 */
export function logAppEvent(entry: AppLogEntry): void {
  void writeAppLog(entry);
}

export interface AppLogFilter {
  level?: string;
  event?: string;
  uid?: string;
}

export interface AppLogRecord {
  id: string;
  ts: number;
  level: string;
  event: string;
  uid: string | null;
  route: string | null;
  status: number | null;
  durationMs: number | null;
  detail: unknown;
}

/**
 * Reads recent logs, newest first. Level/event/uid filters are applied in
 * code (not Firestore `where`) so no composite indexes are ever required.
 */
export async function listAppLogs(
  limit: number,
  cursorTs: number | null,
  filter: AppLogFilter
): Promise<{ logs: AppLogRecord[]; nextCursor: number | null }> {
  let query = db.collection(APP_LOGS_COLLECTION).orderBy('ts', 'desc');
  if (cursorTs !== null) query = query.startAfter(cursorTs);

  // Fetch extra rows when filtering so a full page is usually still returned.
  const scanLimit = filter.level || filter.event || filter.uid
    ? Math.min(300, limit * 5)
    : limit;
  const snapshot = await query.limit(scanLimit).get();

  const logs: AppLogRecord[] = [];
  for (const doc of snapshot.docs) {
    const data = doc.data() || {};
    if (filter.level && data.level !== filter.level) continue;
    if (filter.event && data.event !== filter.event) continue;
    if (filter.uid && data.uid !== filter.uid) continue;
    logs.push({
      id: doc.id,
      ts: typeof data.ts === 'number' ? data.ts : 0,
      level: typeof data.level === 'string' ? data.level : 'info',
      event: typeof data.event === 'string' ? data.event : 'unknown',
      uid: typeof data.uid === 'string' ? data.uid : null,
      route: typeof data.route === 'string' ? data.route : null,
      status: typeof data.status === 'number' ? data.status : null,
      durationMs: typeof data.durationMs === 'number' ? data.durationMs : null,
      detail: data.detail ?? null,
    });
    if (logs.length >= limit) break;
  }

  // A full page means more may exist; the client continues from the last
  // returned record's ts (safer than the last scanned doc when filters
  // skipped trailing rows). Filter-skipped gaps may yield one short empty
  // page — acceptable for a read-only dev tool.
  const nextCursor =
    logs.length === limit && logs.length > 0 ? logs[logs.length - 1].ts : null;

  return { logs, nextCursor };
}
