import { auth, db } from '../config/firebaseAdmin';

/** Read-only Firestore collections exposed to developer tooling. */
const BASE_DEVELOPER_COLLECTIONS = ['users', 'subscriptions', 'payments', 'rateLimits'] as const;

export type DeveloperCollection = string;

/** Parses a comma-separated env allowlist into a normalized Set. */
function parseList(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
  );
}

export interface DeveloperAllowlist {
  uids: Set<string>;
  emails: Set<string>;
}

/**
 * Server-side allowlist used to bootstrap the first developer account (and
 * as an emergency fallback). Emails are compared case-insensitively.
 */
export function getDeveloperAllowlist(): DeveloperAllowlist {
  const emails = new Set<string>();
  for (const email of parseList(process.env.DEVELOPER_EMAILS)) {
    emails.add(email.toLowerCase());
  }
  return { uids: parseList(process.env.DEVELOPER_UIDS), emails };
}

export function isDeveloperAllowlisted(uid: string, email?: string): boolean {
  const { uids, emails } = getDeveloperAllowlist();
  if (uids.has(uid)) return true;
  return Boolean(email && emails.has(email.toLowerCase()));
}

/**
 * Authoritative developer check for low-traffic admin routes:
 * signed custom claim -> env allowlist -> Firestore flag. The Firestore flag
 * is server-only (`users.isDeveloper` and `subscriptions.isDeveloper` are
 * protected by rules), so a client can never grant itself access.
 */
export async function isDeveloperAccount(
  uid: string,
  email?: string,
  claim = false
): Promise<boolean> {
  if (claim || isDeveloperAllowlisted(uid, email)) return true;

  try {
    const profile = await db.collection('users').doc(uid).get();
    const profileData = profile.data() || {};
    if (profile.exists && (profileData.isDeveloper === true || profileData.developer === true)) {
      return true;
    }

    const subscription = await db.collection('subscriptions').doc(uid).get();
    const subscriptionData = subscription.data() || {};
    return (
      subscription.exists &&
      (subscriptionData.isDeveloper === true || subscriptionData.developer === true)
    );
  } catch (error) {
    console.error(`[developer] Access lookup failed uid=${uid.slice(0, 8)}:`, error);
    return false;
  }
}

/** Collections a developer may browse read-only (plus configured chat stores). */
export function getDeveloperCollections(): DeveloperCollection[] {
  return [
    ...BASE_DEVELOPER_COLLECTIONS,
    ...parseList(process.env.CHAT_COLLECTIONS),
  ];
}

export function isDeveloperCollection(name: string): boolean {
  return getDeveloperCollections().includes(name);
}

/** Converts Firestore Timestamps/Dates/nested values into JSON-safe data. */
export function serializeFirestoreValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(serializeFirestoreValue);
  if (typeof value === 'object') {
    const timestamp = value as { toDate?: () => Date };
    if (typeof timestamp.toDate === 'function') {
      const date = timestamp.toDate();
      return date instanceof Date ? date.toISOString() : String(date);
    }
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = serializeFirestoreValue(entry);
    }
    return out;
  }
  return value;
}

export async function countCollection(name: string): Promise<number | null> {
  try {
    const snapshot = await db.collection(name).count().get();
    return snapshot.data().count;
  } catch (error) {
    console.error(`[developer] Count failed for ${name}:`, error);
    return null;
  }
}

export interface ProviderKeyUsage {
  configured: boolean;
  model: string;
  ok: boolean;
  usage: number | null;
  limit: number | null;
  limitRemaining: number | null;
  isFreeTier: boolean | null;
  rateLimit: unknown;
  error?: string;
  note?: string;
}

export interface ProviderUsageReport {
  openrouter: ProviderKeyUsage;
  groq: ProviderKeyUsage;
  razorpay: { configured: boolean; mode: 'live' | 'test' | null };
}

const OPENROUTER_KEY_URL = 'https://openrouter.ai/api/v1/key';
const PROVIDER_USAGE_TIMEOUT_MS = 5000;

function groqModel(): string {
  return process.env.GROQ_MODEL || process.env.FALLBACK_MODEL || 'openai/gpt-oss-20b';
}

function openRouterModel(): string {
  return process.env.OPENROUTER_MODEL || process.env.PRIMARY_MODEL || 'qwen/qwen3-14b';
}

/**
 * Reports provider-key health/usage without ever returning the key itself.
 * OpenRouter exposes a key-usage endpoint; Groq has no public usage API, so
 * its entry reports configuration/model only.
 */
export async function getProviderUsage(): Promise<ProviderUsageReport> {
  const openRouterKey = process.env.OPENROUTER_API_KEY || process.env.PRIMARY_API_KEY || '';
  const groqKey = process.env.GROQ_API_KEY || '';

  const openrouter: ProviderKeyUsage = {
    configured: Boolean(openRouterKey),
    model: openRouterModel(),
    ok: false,
    usage: null,
    limit: null,
    limitRemaining: null,
    isFreeTier: null,
    rateLimit: null,
  };

  if (openRouterKey) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROVIDER_USAGE_TIMEOUT_MS);
    try {
      const response = await fetch(OPENROUTER_KEY_URL, {
        headers: { Authorization: `Bearer ${openRouterKey}` },
        signal: controller.signal,
      });
      const payload = (await response.json().catch(() => null)) as {
        data?: Record<string, unknown>;
        error?: { message?: string };
      } | null;
      const data = payload?.data ?? {};
      openrouter.ok = response.ok;
      openrouter.usage = typeof data.usage === 'number' ? data.usage : null;
      openrouter.limit = typeof data.limit === 'number' ? data.limit : null;
      openrouter.limitRemaining =
        typeof data.limit_remaining === 'number' ? data.limit_remaining : null;
      openrouter.isFreeTier =
        typeof data.is_free_tier === 'boolean' ? data.is_free_tier : null;
      openrouter.rateLimit = data.rate_limit ?? null;
      if (!response.ok) {
        openrouter.error = payload?.error?.message || `HTTP ${response.status}`;
      }
    } catch (error) {
      openrouter.error = String((error as Error).message || error);
    } finally {
      clearTimeout(timer);
    }
  }

  const razorpayKeyId = process.env.RAZORPAY_KEY_ID || '';

  return {
    openrouter,
    groq: {
      configured: Boolean(groqKey),
      model: groqModel(),
      ok: Boolean(groqKey),
      usage: null,
      limit: null,
      limitRemaining: null,
      isFreeTier: null,
      rateLimit: null,
      note: 'Groq does not expose a public per-key usage API; see the Groq console for spend.',
    },
    razorpay: {
      configured: Boolean(razorpayKeyId && process.env.RAZORPAY_KEY_SECRET),
      mode: razorpayKeyId ? (razorpayKeyId.startsWith('rzp_live_') ? 'live' : 'test') : null,
    },
  };
}

/** Firebase Auth records for the developer user browser. */
export async function listAuthUsers(
  limit: number,
  pageToken?: string
): Promise<{ users: Array<Record<string, unknown>>; nextPageToken: string | null }> {
  const result = await auth.listUsers(limit, pageToken);
  return {
    users: result.users.map((user) => ({
      uid: user.uid,
      email: user.email ?? null,
      displayName: user.displayName ?? null,
      phoneNumber: user.phoneNumber ?? null,
      disabled: user.disabled,
      emailVerified: user.emailVerified,
      createdAt: user.metadata.creationTime ?? null,
      lastSignInAt: user.metadata.lastSignInTime ?? null,
      providers: (user.providerData ?? []).map((provider) => provider.providerId),
    })),
    nextPageToken: result.pageToken ?? null,
  };
}
