import { Response, Request } from 'express';
import {
  PersonalityType,
  PERSONALITIES,
  LimitReachedError,
  AI_TIMEOUT_MS,
  isPersonalityAllowed,
  PlanType,
} from '../constants';
import { buildSystemPrompt, RELIGION_KEYS } from '../services/promptService';
import { consumeMessage, getPlanState } from '../services/messageService';
import { consumeRateLimit, RateLimitExceededError } from '../services/rateLimitService';
import { AuthenticatedRequest } from '../middleware/authMiddleware';
import { extractClientIp } from '../utils/request';
import {
  verifyAppCheckToken,
  isAppCheckEnforced,
  AppCheckResult,
} from '../services/appCheckService';
import {
  enforceChatIpThrottle,
  CHAT_IP_RATE_LIMIT_MAX,
  CHAT_IP_RATE_LIMIT_WINDOW_MS,
} from '../services/chatClientThrottle';

// Abuse backstop on top of the plan quota: a stolen ID token or a scripted
// client cannot hammer the AI providers. Fail-open like the payment limiters.
const CHAT_RATE_LIMIT_MAX = 30;
const CHAT_RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

interface ModelTarget {
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  // Extra body fields merged into the request (used to suppress any
  // hidden chain-of-thought output on models that support a reasoning mode).
  extraBody?: Record<string, unknown>;
}

// Primary model — Qwen3-14B (Apache 2.0) served via OpenRouter (Groq does
// not host Qwen models). NOTE: the old slug qwen/qwen-2.5-14b-instruct was
// removed from OpenRouter's catalog; qwen3-14b is its successor. Qwen3 runs
// in non-thinking mode by default; reasoning.enabled=false is sent anyway so
// no <think> chain-of-thought can ever leak into the reply.
const PRIMARY: ModelTarget = {
  name: 'primary',
  baseUrl: process.env.PRIMARY_BASE_URL || 'https://openrouter.ai/api/v1/chat/completions',
  apiKey: process.env.PRIMARY_API_KEY || OPENROUTER_API_KEY || '',
  model: process.env.PRIMARY_MODEL || 'qwen/qwen3-14b',
  extraBody: { reasoning: { enabled: false } },
};
// Fallback model — GPT-OSS 20B on Groq: fast and cheap. NOTE: Groq shut down
// llama-3.1-8b-instant (and all Llama chat models) on 2026-08-16, so the
// Llama family is gone from Groq. gpt-oss-20b is Groq's recommended
// replacement. It rejects reasoning_effort:'none' (only low/medium/high are
// allowed), so use 'low' — its reasoning comes back in a separate field and
// never leaks into the visible reply content.
const FALLBACK: ModelTarget = {
  name: 'fallback',
  baseUrl: 'https://api.groq.com/openai/v1/chat/completions',
  apiKey: GROQ_API_KEY || '',
  model: process.env.FALLBACK_MODEL || 'openai/gpt-oss-20b',
  extraBody: { reasoning_effort: 'low' },
};
// Both models are plain instruct models (no hidden reasoning tokens), so the
// budget goes straight to the visible reply. The system prompt asks for
// short, human-scale replies (mostly 1-3 sentences); 600 is a generous ceiling
// that still caps runaway responses without mid-sentence truncation.
const MAX_TOKENS = 600;
const MAX_MESSAGE_LENGTH = 4000;

// ---------------------------------------------------------------------------
// Provider circuit breakers (per-instance, in-memory)
//
// Every request used to wait out the full primary timeout before even
// STARTING the fallback — when OpenRouter degrades, the whole userbase
// experiences ~2x latency and elevated 503s. The breaker remembers recent
// failures per model on this instance: after N consecutive failures the
// model is skipped for COOLDOWN_MS, then probed again (half-open). Inexact
// across serverless instances, but it turns a provider outage from
// "every request pays the timeout" into "most requests go straight to the
// healthy provider".
// ---------------------------------------------------------------------------
const BREAKER_THRESHOLD = 5;
const BREAKER_COOLDOWN_MS = 60_000;

interface BreakerState {
  consecutiveFailures: number;
  openedAt: number | null;
}

const breakers = new Map<string, BreakerState>();

function getModelBreaker(name: string): BreakerState {
  let state = breakers.get(name);
  if (!state) {
    state = { consecutiveFailures: 0, openedAt: null };
    breakers.set(name, state);
  }
  return state;
}

/** True when the breaker is OPEN (skip this model). Half-open after cooldown. */
function isModelSkipped(name: string): boolean {
  const state = getModelBreaker(name);
  if (state.openedAt === null) return false;
  if (Date.now() - state.openedAt >= BREAKER_COOLDOWN_MS) {
    // Cooldown elapsed: allow a probe request through (half-open).
    return false;
  }
  return true;
}

function recordModelResult(name: string, ok: boolean): void {
  const state = getModelBreaker(name);
  if (ok) {
    state.consecutiveFailures = 0;
    state.openedAt = null;
    return;
  }
  state.consecutiveFailures += 1;
  if (state.consecutiveFailures >= BREAKER_THRESHOLD) {
    if (state.openedAt === null) {
      console.warn(`[chat] Circuit breaker OPEN for ${name} (${BREAKER_THRESHOLD} consecutive failures)`);
    }
    state.openedAt = Date.now();
  }
}

interface GroqAttempt {
  ok: boolean;
  status?: number;
  errorData?: unknown;
  reply?: string;
}

/** Single completion attempt against a model target. Never throws — failures are returned. */
async function callModel(
  target: ModelTarget,
  messages: { role: string; content: string }[],
  clientGoneSignal?: AbortSignal
): Promise<GroqAttempt> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
  // Abort the fetch too when the client hangs up — no point paying for
  // tokens for a reply nobody will read.
  const onClientGone = () => controller.abort();
  if (clientGoneSignal) {
    if (clientGoneSignal.aborted) controller.abort();
    else clientGoneSignal.addEventListener('abort', onClientGone, { once: true });
  }
  try {
    if (!target.apiKey) {
      return { ok: false, status: undefined, errorData: `missing API key for ${target.name}` };
    }
    const response = await fetch(target.baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${target.apiKey}`,
      },
      body: JSON.stringify({
        model: target.model,
        messages,
        max_tokens: MAX_TOKENS,
        temperature: 0.8,
        ...(target.extraBody || {}),
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      return { ok: false, status: response.status, errorData };
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return { ok: true, reply: data.choices?.[0]?.message?.content?.trim() ?? '' };
  } catch (error) {
    return { ok: false, status: undefined, errorData: error };
  } finally {
    clearTimeout(timer);
    if (clientGoneSignal) clientGoneSignal.removeEventListener('abort', onClientGone);
  }
}

/** Never rejects — resolves { attempt, index } or null on failure. */
function startAttempt(
  target: ModelTarget,
  messages: { role: string; content: string }[],
  delayMs: number,
  clientGoneSignal?: AbortSignal
): Promise<{ attempt: GroqAttempt; target: ModelTarget } | null> {
  const run = async (): Promise<{ attempt: GroqAttempt; target: ModelTarget } | null> => {
    const attempt = await callModel(target, messages, clientGoneSignal);
    recordModelResult(target.name, attempt.ok && !!attempt.reply);
    return { attempt, target };
  };
  const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  const wrapped: Promise<{ attempt: GroqAttempt; target: ModelTarget } | null> =
    delayMs > 0 ? delay(delayMs).then(() => run()) : run();
  // Absolute guarantee against unhandled rejections: attempts never reject.
  return wrapped.catch((error: unknown) => {
    console.error(`[chat] Attempt machinery error (${target.name}):`, error);
    return null;
  });
}

/**
 * Sends a JSON response unless the socket is already gone (mobile clients
 * abort on ~10s read timeouts; writing to the dead socket is pointless).
 */
function sendJson(res: Response, status: number, payload: unknown): void {
  if (res.writableEnded || res.destroyed) return;
  res.status(status).json(payload);
}

export async function chatSendHandler(req: Request, res: Response): Promise<void> {
  // Abort path when the client hangs up (mobile networks switch, apps get
  // backgrounded). Without this, an abandoned request still runs to
  // completion — paying for AI tokens and consuming the user's quota for a
  // reply they never received.
  const clientGone = new AbortController();
  const onSocketClose = () => clientGone.abort();
  req.socket.on('close', onSocketClose);
  try {
    await handleChatSend(req as AuthenticatedRequest, res, clientGone.signal);
  } finally {
    req.socket.removeListener('close', onSocketClose);
  }
}

async function handleChatSend(
  req: AuthenticatedRequest,
  res: Response,
  clientGoneSignal: AbortSignal
): Promise<void> {
  // uid is always taken from the verified Firebase token — never from the body/query.
  const uid = req.user!.uid;
  const body = (req.body || {}) as {
    message?: unknown;
    messages?: unknown;
    personality?: unknown;
    religionSubType?: unknown;
  };

  // --- Input validation (with legacy-app compatibility) ---
  // Older app builds sent the raw Groq-style payload { messages: [...] }
  // instead of { message: string }. Accept both: if `message` is missing,
  // fall back to the content of the last message in the `messages` array.
  let rawMessage: unknown = body.message;
  if (typeof rawMessage !== 'string' && Array.isArray(body.messages) && body.messages.length > 0) {
    const legacyMessages = body.messages as Array<{ role?: unknown; content?: unknown } | null>;
    // Legacy apps sent full alternating history — prefer the latest user turn.
    for (let i = legacyMessages.length - 1; i >= 0; i--) {
      const entry = legacyMessages[i];
      if (entry && typeof entry.content === 'string' && entry.role === 'user') {
        rawMessage = entry.content;
        break;
      }
    }
    // No user-role entry found: fall back to the newest entry with content.
    if (typeof rawMessage !== 'string') {
      for (let i = legacyMessages.length - 1; i >= 0; i--) {
        const entry = legacyMessages[i];
        if (entry && typeof entry.content === 'string') {
          rawMessage = entry.content;
          break;
        }
      }
    }
  }

  if (typeof rawMessage !== 'string') {
    sendJson(res, 400, { error: 'message must be a string' });
    return;
  }
  const trimmed = rawMessage.trim();
  if (trimmed.length < 1 || trimmed.length > MAX_MESSAGE_LENGTH) {
    sendJson(res, 400, { error: `message must be 1-${MAX_MESSAGE_LENGTH} characters` });
    return;
  }

  // Legacy app payloads may not send a personality — default to Friend
  // (the same fallback buildSystemPrompt uses). But an explicitly invalid
  // personality is rejected (consistent with religionSubType) so clients get
  // clear feedback instead of silently talking to a different persona.
  let personality: PersonalityType = 'Friend';
  let religionSubType: string | undefined =
    typeof body.religionSubType === 'string' ? body.religionSubType : undefined;

  // Frontend compat: "Guide_<religion>" (e.g. "Guide_hindu") selects the Guide
  // persona with that faith overlay in one field. Normalize it server-side.
  const guideAlias =
    typeof body.personality === 'string' && body.personality.startsWith('Guide_')
      ? body.personality
      : null;

  if (body.personality !== undefined && !guideAlias) {
    if (
      typeof body.personality !== 'string' ||
      !PERSONALITIES.includes(body.personality as PersonalityType)
    ) {
      sendJson(res, 400, {
        error: `Invalid personality. Valid options: ${PERSONALITIES.join(', ')}`,
      });
      return;
    }
    personality = body.personality as PersonalityType;
  }

  if (guideAlias) {
    personality = 'Guide';
    const aliasReligion = guideAlias.slice('Guide_'.length).toLowerCase();
    if (RELIGION_KEYS.includes(aliasReligion)) {
      religionSubType = aliasReligion;
    }
    // Unknown Guide_<x> suffix: keep Guide without a faith layer (buildSystemPrompt
    // already handles a missing/unknown subtype via its spiritual fallback). To
    // stay strict about what reaches the system prompt, pass undefined when the
    // suffix isn't a known religion key.
    else {
      religionSubType = undefined;
    }
  }

  // religionSubType is user input injected into the system prompt — allowlist only.
  if (religionSubType !== undefined) {
    if (!RELIGION_KEYS.includes(religionSubType.toLowerCase())) {
      sendJson(res, 400, { error: 'Invalid religionSubType' });
      return;
    }
    religionSubType = religionSubType.toLowerCase();
  }

  // --- Env guard (fail with a clear error instead of a crash) ---
  if (!PRIMARY.apiKey && !FALLBACK.apiKey) {
    console.error(`[chat uid=${uid}] Missing OPENROUTER_API_KEY and GROQ_API_KEY env vars`);
    sendJson(res, 503, { error: 'AI service unavailable', code: 'ai_key_missing' });
    return;
  }

  // --- Server-side persona gating (the frontend UI lock is cosmetic) ---
  // A 403 here must NOT consume quota and must NOT call any AI provider.
  let plan: PlanType;
  try {
    plan = (await getPlanState(uid)).plan;
  } catch (error) {
    console.error(`[chat uid=${uid}] Plan lookup failed:`, error);
    sendJson(res, 500, { error: 'Internal server error' });
    return;
  }
  if (!isPersonalityAllowed(plan, personality)) {
    sendJson(res, 403, {
      error: `The ${personality} personality requires a Pro plan. Upgrade to unlock it.`,
      code: 'persona_locked',
      plan,
      personality,
    });
    return;
  }

  // --- Device attestation (opt-in; see appCheckService.ts) ---
  // Creating Firebase accounts is free, so uid-keyed quotas alone cannot cap
  // the AI bill: one script can farm thousands of accounts. When
  // ENABLE_APP_CHECK=true, invalid App Check tokens are rejected and missing
  // tokens fall through to the (much tighter) IP throttle below.
  if (isAppCheckEnforced()) {
    const appCheck: AppCheckResult = await verifyAppCheckToken(req);
    if (appCheck === 'invalid') {
      console.warn(`[chat uid=${uid.slice(0, 8)}] App Check token invalid — rejecting`);
      sendJson(res, 401, { error: 'App Check verification failed', code: 'app_check_invalid' });
      return;
    }
    if (appCheck === 'missing') {
      console.warn(
        `[chat uid=${uid.slice(0, 8)}] App Check enabled but no token; applying IP throttle (${CHAT_IP_RATE_LIMIT_MAX}/${CHAT_IP_RATE_LIMIT_WINDOW_MS / 60000}min)`
      );
    }
  }

  // --- Per-IP throttle: caps free-signup farming from one address ---
  // Independent of (and in addition to) the per-uid limit below. See
  // chatClientThrottle.ts for why it is IP-based and what the limits mean.
  try {
    const ip = extractClientIp(req);
    if (ip) {
      await enforceChatIpThrottle(ip);
    }
  } catch (error) {
    if (error instanceof RateLimitExceededError) {
      sendJson(res, 429, {
        limitReached: true,
        error: 'Too many requests, try again later',
        code: 'ip_rate_limited',
        nextRefreshAt: Date.now() + error.retryAfterMs,
      });
      return;
    }
    console.error('[chat] IP throttle check failed (allowing request):', error);
  }

  // --- Abuse rate limit (independent of the plan message quota) ---
  // Fail-open on limiter storage errors (consistent with the payment
  // limiters): availability beats throttling when the limiter itself is
  // broken — plan quota below still caps usage.
  try {
    await consumeRateLimit(`chat:${uid}`, CHAT_RATE_LIMIT_MAX, CHAT_RATE_LIMIT_WINDOW_MS);
  } catch (error) {
    if (error instanceof RateLimitExceededError) {
      sendJson(res, 429, {
        limitReached: true,
        error: 'Too many requests, try again later',
        nextRefreshAt: Date.now() + error.retryAfterMs,
      });
      return;
    }
    console.error(`[chat uid=${uid}] Rate limit check failed (allowing request):`, error);
  }

  const systemPrompt = buildSystemPrompt(personality, religionSubType);
  const messages = [
    { role: 'system' as const, content: systemPrompt },
    { role: 'user' as const, content: trimmed },
  ];

  // --- Race primary and fallback STAGGERED IN PARALLEL ---
  // The old code tried providers strictly sequentially: with a dead/hung
  // primary, every request waited the full AI_TIMEOUT_MS before the fallback
  // even started (worst case 2x timeout). Here the fallback starts after a
  // short head start for the primary — a slow primary can still win, but a
  // DOWNED primary no longer doubles everyone's latency. Per-model circuit
  // breakers skip a provider that is clearly down.
  const targetsToTry = PRIMARY.model === FALLBACK.model ? [PRIMARY] : [PRIMARY, FALLBACK];
  const STAGGER_MS = 300;

  const candidates = targetsToTry.filter((t) => t.apiKey && !isModelSkipped(t.name));
  // If every candidate is breaker-open, still try (half-open probes resolve
  // this naturally on the next cooldown expiry, but never return 503 without
  // at least one real attempt).
  const attempts = (candidates.length > 0 ? candidates : targetsToTry.filter((t) => t.apiKey)).map(
    (target, index) => startAttempt(target, messages, index * STAGGER_MS, clientGoneSignal)
  );

  let reply = '';
  let usedTarget: ModelTarget | null = null;
  for (const attemptPromise of attempts) {
    if (clientGoneSignal.aborted) break;
    const result = await attemptPromise;
    if (!result) continue;
    const { attempt, target } = result;
    if (attempt.ok && attempt.reply) {
      reply = attempt.reply;
      usedTarget = target;
      break;
    }
    if (attempt.ok) {
      // HTTP 200 but no content — e.g. the token budget was hit before any
      // text was produced, or the model filtered the response.
      console.error(
        `[chat uid=${uid}] Upstream returned HTTP 200 with empty content (${target.name} model=${target.model})`
      );
    } else {
      console.error(
        `[chat uid=${uid}] Upstream call failed (${target.name} model=${target.model} status=${attempt.status ?? 'network/timeout'})`,
        attempt.errorData
      );
    }
  }

  // The client (or its proxy) gave up — do not consume quota, do not attempt
  // to deliver. Return quietly; the socket is already closed.
  if (clientGoneSignal.aborted) {
    console.log(`[chat uid=${uid}] Client disconnected before reply — not consuming quota`);
    return;
  }

  if (!reply) {
    sendJson(res, 503, { error: 'AI service unavailable', code: 'ai_upstream_error' });
    return;
  }
  if (usedTarget) {
    console.log(`[chat uid=${uid}] Reply served by ${usedTarget.name} (${usedTarget.model})`);
  }

  // AI responded successfully — only now consume a message from the quota.
  try {
    await consumeMessage(uid);
  } catch (error) {
    if (error instanceof LimitReachedError) {
      sendJson(res, 429, {
        limitReached: true,
        nextRefreshAt: error.nextRefreshAt,
      });
      return;
    }
    console.error(`[chat uid=${uid}] Message quota consume failed:`, error);
    sendJson(res, 500, { error: 'Internal server error' });
    return;
  }

  sendJson(res, 200, {
    reply,
    // Echo back the effective persona so clients can confirm what was used.
    personality,
    religionSubType: religionSubType ?? null,
    // Legacy app builds parse the raw OpenAI-style shape
    // (data.choices[0].message.content) instead of data.reply — return both
    // so old and new app versions both work.
    choices: [{ message: { role: 'assistant' as const, content: reply } }],
  });
}
