import { Response, Request } from 'express';
import {
  PersonalityType,
  PERSONALITIES,
  PERSONALITY_ALIASES,
  RELIGION_ALIASES,
  LimitReachedError,
  AI_TIMEOUT_MS,
  CHAT_FALLBACK_STAGGER_MS,
  PLAN_CONFIG,
  isPersonalityAllowed,
  isStrangerPersonality,
  PlanType,
  getQuotaUsageFraction,
} from '../constants';
import { buildSystemPrompt, RELIGION_KEYS } from '../services/promptService';
import {
  consumeMessage,
  getPlanState,
  UserMessageState,
} from '../services/messageService';
import { consumeRateLimit, RateLimitExceededError } from '../services/rateLimitService';
import { AuthenticatedRequest } from '../middleware/authMiddleware';
import { extractClientIp } from '../utils/request';
import { logAppEvent, writeAppLog } from '../services/logService';
import {
  verifyAppCheckToken,
  isAppCheckEnforced,
  AppCheckResult,
} from '../services/appCheckService';
import {
  enforceChatIpThrottle,
  getChatIpRateLimitMax,
  getChatIpRateLimitWindowMs,
} from '../services/chatClientThrottle';

// Abuse backstop on top of the plan quota: a stolen ID token or a scripted
// client cannot hammer the AI providers. Fail-open like the payment limiters.
const CHAT_RATE_LIMIT_MAX = 30;
const CHAT_RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;

interface ModelTarget {
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  // Extra body fields merged into the request (used to suppress any
  // hidden chain-of-thought output on models that support a reasoning mode).
  extraBody?: Record<string, unknown>;
}

/** Groq (gpt-oss-20b) — default primary, fastest to first token. */
function groqTarget(): ModelTarget {
  return {
    name: 'groq',
    baseUrl: 'https://api.groq.com/openai/v1/chat/completions',
    apiKey: process.env.GROQ_API_KEY || '',
    model: process.env.GROQ_MODEL || process.env.FALLBACK_MODEL || 'openai/gpt-oss-20b',
    extraBody: { reasoning_effort: 'low', service_tier: 'on_demand' },
  };
}

/** OpenRouter (Qwen3-14B) — slower, stronger; the fallback. */
function openRouterTarget(): ModelTarget {
  return {
    name: 'openrouter',
    baseUrl: process.env.PRIMARY_BASE_URL || 'https://openrouter.ai/api/v1/chat/completions',
    apiKey: process.env.PRIMARY_API_KEY || process.env.OPENROUTER_API_KEY || '',
    model: process.env.OPENROUTER_MODEL || process.env.PRIMARY_MODEL || 'qwen/qwen3-14b',
    extraBody: { reasoning: { enabled: false } },
  };
}

/** Which provider answers first. Set CHAT_PRIMARY_PROVIDER=openrouter to flip. */
function primaryProvider(): 'groq' | 'openrouter' {
  return (process.env.CHAT_PRIMARY_PROVIDER || '').toLowerCase() === 'openrouter'
    ? 'openrouter'
    : 'groq';
}

/**
 * Provider targets, read per request so env stubs and rotation apply
 * without a restart.
 */
function getModelTargets(): { PRIMARY: ModelTarget; FALLBACK: ModelTarget } {
  const groq = groqTarget();
  const openRouter = openRouterTarget();
  return primaryProvider() === 'openrouter'
    ? { PRIMARY: openRouter, FALLBACK: groq }
    : { PRIMARY: groq, FALLBACK: openRouter };
}
// Replies are short (1-3 sentences), so 300 tokens caps runaways without
// mid-sentence cuts. Generation time scales with tokens emitted, so this
// stays tight for latency.
const MAX_TOKENS = 300;
const MAX_MESSAGE_LENGTH = 2000;
// Some OpenAI-compatible models occasionally emit one of their internal
// end-of-turn tokens and then continue generating junk. Ask providers to stop
// there, and also filter them locally because a provider can ignore `stop`.
const MODEL_STOP_MARKERS = ['<|endoftext|>', '<|im_end|>', '<|end|>'];
// Bound on the legacy `messages[]` fallback so one request can't force the
// server to scan an unbounded array.
const MAX_LEGACY_MESSAGES = 50;
// Keep enough recent turns for a natural conversation without letting one
// request create an unbounded model context or bill.
const MAX_CONTEXT_MESSAGES = 16;
const MAX_CONTEXT_CHARACTERS = 12_000;

interface ChatHistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** Remove an accidental model control token and everything after it. */
function removeModelContinuation(text: string): string {
  let stopAt = text.length;
  for (const marker of MODEL_STOP_MARKERS) {
    const index = text.indexOf(marker);
    if (index !== -1 && index < stopAt) stopAt = index;
  }
  return text.slice(0, stopAt);
}

/**
 * A streaming control token can be split over several network chunks. Keep
 * only a possible marker prefix pending so no part of it reaches the client.
 */
function splitSafeStreamText(text: string): { safe: string; pending: string; stopped: boolean } {
  const cleaned = removeModelContinuation(text);
  if (cleaned.length !== text.length) return { safe: cleaned, pending: '', stopped: true };

  let pendingLength = 0;
  for (const marker of MODEL_STOP_MARKERS) {
    const max = Math.min(marker.length - 1, text.length);
    for (let length = max; length > pendingLength; length--) {
      if (marker.startsWith(text.slice(-length))) {
        pendingLength = length;
        break;
      }
    }
  }
  return {
    safe: text.slice(0, text.length - pendingLength),
    pending: text.slice(text.length - pendingLength),
    stopped: false,
  };
}

/**
 * Keeps recent client-supplied conversation turns. System messages are never
 * accepted from clients, and the current user message is always appended once.
 */
function buildConversationHistory(rawHistory: unknown, latestUserMessage: string): ChatHistoryMessage[] {
  if (!Array.isArray(rawHistory)) {
    return [{ role: 'user', content: latestUserMessage }];
  }

  const valid: ChatHistoryMessage[] = [];
  for (const item of rawHistory) {
    if (!item || typeof item !== 'object') continue;
    const { role, content } = item as { role?: unknown; content?: unknown };
    if ((role !== 'user' && role !== 'assistant') || typeof content !== 'string') continue;
    const trimmedContent = content.trim();
    if (trimmedContent.length === 0 || trimmedContent.length > MAX_MESSAGE_LENGTH) continue;
    valid.push({ role, content: trimmedContent });
  }

  // If `messages` already contains the current turn, discard it and append a
  // single trusted copy below. If no separate `message` was supplied, ignore
  // any malformed trailing assistant turn after the last user message.
  const lastUserIndex = valid.map((entry) => entry.role).lastIndexOf('user');
  const beforeCurrent =
    lastUserIndex >= 0 && valid[lastUserIndex]?.content === latestUserMessage
      ? valid.slice(0, lastUserIndex)
      : valid;

  const selected: ChatHistoryMessage[] = [];
  let characters = latestUserMessage.length;
  for (let index = beforeCurrent.length - 1; index >= 0; index--) {
    const entry = beforeCurrent[index];
    if (selected.length >= MAX_CONTEXT_MESSAGES - 1) break;
    if (characters + entry.content.length > MAX_CONTEXT_CHARACTERS) break;
    characters += entry.content.length;
    selected.unshift(entry);
  }
  return [...selected, { role: 'user', content: latestUserMessage }];
}

// Provider circuit breakers (per-instance, in-memory). After N consecutive
// failures a model is skipped for a cooldown, then probed again. Inexact
// across serverless instances, but keeps one dead provider from taxing every
// request with a full timeout.
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

/** True when the breaker is open (skip this model until cooldown passes). */
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

/** Single completion attempt. Never throws — failures are returned. */
async function callModel(
  target: ModelTarget,
  messages: { role: string; content: string }[],
  clientGoneSignal?: AbortSignal
): Promise<GroqAttempt> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
  // Abort the fetch when the client hangs up — no paid tokens for an unread reply.
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
        stop: MODEL_STOP_MARKERS,
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
    return {
      ok: true,
      reply: removeModelContinuation(data.choices?.[0]?.message?.content?.trim() ?? ''),
    };
  } catch (error) {
    return { ok: false, status: undefined, errorData: error };
  } finally {
    clearTimeout(timer);
    if (clientGoneSignal) clientGoneSignal.removeEventListener('abort', onClientGone);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * Queued model attempt. Never rejects. `releaseEarly` lets a queued attempt
 * skip its delay once an earlier attempt has definitively failed, so a dead
 * primary fails over without the full stagger of dead air.
 */
function startAttempt(
  target: ModelTarget,
  messages: { role: string; content: string }[],
  delayMs: number,
  clientGoneSignal?: AbortSignal,
  releaseEarly?: Promise<void>
): Promise<{ attempt: GroqAttempt; target: ModelTarget } | null> {
  const run = async (): Promise<{ attempt: GroqAttempt; target: ModelTarget } | null> => {
    const attempt = await callModel(target, messages, clientGoneSignal);
    recordModelResult(target.name, attempt.ok && !!attempt.reply);
    return { attempt, target };
  };
  let wait: Promise<void>;
  if (delayMs <= 0) {
    wait = Promise.resolve();
  } else if (releaseEarly) {
    wait = Promise.race([delay(delayMs), releaseEarly]);
  } else {
    wait = delay(delayMs);
  }
  const wrapped: Promise<{ attempt: GroqAttempt; target: ModelTarget } | null> = wait.then(() =>
    run()
  );
  return wrapped.catch((error: unknown) => {
    console.error(`[chat] Attempt machinery error (${target.name}):`, error);
    return null;
  });
}

/** True when an attempt produced no usable reply (error, timeout, empty body). */
function attemptFailed(result: { attempt: GroqAttempt } | null): boolean {
  return !result || !result.attempt.ok || !result.attempt.reply;
}

/** True when the client asked for token streaming (progressive render). */
function wantsStream(req: Request): boolean {
  const query = (req.query || {}) as Record<string, unknown>;
  if (query.stream === '1' || query.stream === 'true') return true;
  const accept = req.headers.accept || '';
  return accept.includes('text/event-stream');
}

/**
 * Streams one completion attempt, forwarding tokens as they arrive.
 * First token wins the race; the loser is aborted and never counts as a
 * breaker failure. Never throws.
 */
async function streamAttempt(
  target: ModelTarget,
  messages: { role: string; content: string }[],
  opts: {
    signal?: AbortSignal;
    onToken: (token: string) => void;
    onFirstToken: () => void;
  }
): Promise<GroqAttempt> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
  const onExternalAbort = () => controller.abort();
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener('abort', onExternalAbort, { once: true });
  }
  try {
    if (!target.apiKey) {
      return { ok: false, status: undefined, errorData: `missing API key for ${target.name}` };
    }
    let response: globalThis.Response;
    try {
      response = await fetch(target.baseUrl, {
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
          stream: true,
          stop: MODEL_STOP_MARKERS,
          ...(target.extraBody || {}),
        }),
        signal: controller.signal,
      });
    } catch (error: unknown) {
      return { ok: false, status: undefined, errorData: error };
    }

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      return { ok: false, status: response.status, errorData };
    }
    const body = response.body;
    if (!body) {
      return { ok: false, status: response.status, errorData: 'empty stream body' };
    }

    let full = '';
    let gotFirst = false;
    let buffer = '';
    let pendingControlToken = '';
    const decoder = new TextDecoder();
    const stream = body as unknown as AsyncIterable<Uint8Array>;
    const forwardSafeText = (text: string): void => {
      if (!text) return;
      if (!gotFirst) {
        gotFirst = true;
        opts.onFirstToken();
      }
      full += text;
      opts.onToken(text);
    };
    const handleDelta = (delta: string): boolean => {
      const split = splitSafeStreamText(pendingControlToken + delta);
      pendingControlToken = split.pending;
      forwardSafeText(split.safe);
      return split.stopped;
    };
    for await (const chunk of stream) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice('data:'.length).trim();
        if (payload === '[DONE]') break;
        let delta = '';
        try {
          const parsed = JSON.parse(payload) as {
            choices?: Array<{ delta?: { content?: string } }>;
          };
          delta = parsed.choices?.[0]?.delta?.content ?? '';
        } catch {
          continue;
        }
        if (delta && handleDelta(delta)) {
          // Do not forward model control tokens or their continuation.
          controller.abort();
          return { ok: full.length > 0, reply: full };
        }
      }
    }
    // Flush any trailing buffered line (non-chunked test doubles).
    const tail = buffer.trim();
    if (tail.startsWith('data:')) {
      const payload = tail.slice('data:'.length).trim();
      if (payload && payload !== '[DONE]') {
        try {
          const parsed = JSON.parse(payload) as {
            choices?: Array<{ delta?: { content?: string } }>;
          };
          const delta = parsed.choices?.[0]?.delta?.content ?? '';
          if (delta && handleDelta(delta)) return { ok: full.length > 0, reply: full };
        } catch {
          // ignore trailing garbage
        }
      }
    }
    // A harmless partial marker at the end is ordinary text, so release it.
    forwardSafeText(pendingControlToken);
    // NOTE: no recordModelResult here — the streaming race aborts the loser
    // mid-flight, and an aborted-healthy provider must not count as failure.
    return { ok: full.length > 0, reply: full };
  } catch (error) {
    return { ok: false, status: undefined, errorData: error };
  } finally {
    clearTimeout(timer);
    if (opts.signal) opts.signal.removeEventListener('abort', onExternalAbort);
  }
}

/** Sends JSON unless the socket is already gone. */
function sendJson(res: Response, status: number, payload: unknown): void {
  if (res.writableEnded || res.destroyed) return;
  res.status(status).json(payload);
}

export async function chatSendHandler(req: Request, res: Response): Promise<void> {
  // Abort when the client hangs up so abandoned requests don't burn AI
  // tokens or quota. Listens on the response: on serverless runtimes the
  // request socket emits 'close' after the body is read (not on disconnect),
  // so a req.socket listener would abort every request.
  const clientGone = new AbortController();
  const onResponseClose = () => {
    if (!res.writableEnded) clientGone.abort();
  };
  res.on('close', onResponseClose);
  try {
    await handleChatSend(req as AuthenticatedRequest, res, clientGone.signal);
  } finally {
    res.removeListener('close', onResponseClose);
  }
}

async function handleChatSend(
  req: AuthenticatedRequest,
  res: Response,
  clientGoneSignal: AbortSignal
): Promise<void> {
  // uid is always taken from the verified Firebase token — never from the body/query.
  const uid = req.user!.uid;
  const isDeveloper = req.user!.developer === true;
  const body = (req.body || {}) as {
    message?: unknown;
    messages?: unknown;
    personality?: unknown;
    religionSubType?: unknown;
  };

  // --- Input validation (with legacy-app compatibility) ---
  // Clients may send a current `message` plus recent `messages` history.
  // History is capped before parsing so one request cannot create an
  // unbounded model context.
  if (Array.isArray(body.messages) && body.messages.length > MAX_LEGACY_MESSAGES) {
    sendJson(res, 400, { error: 'Too many messages in one request' });
    return;
  }
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
   // No user-role entry: fall back to the newest entry with content.
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

  // Personality: omitted defaults to Friend; explicitly invalid is rejected.
  // Legacy shorthands (BestFriend, BF, GF) are coerced so old app versions
  // and stored values keep working. "Guide_<religion>" selects Guide with
  // that overlay.
  let personality: PersonalityType = 'Friend';
  let religionSubType: string | undefined =
    typeof body.religionSubType === 'string' ? body.religionSubType : undefined;

  const requestedPersonality =
    typeof body.personality === 'string'
      ? (PERSONALITY_ALIASES[body.personality] ?? body.personality)
      : body.personality;
  const guideAlias =
    typeof requestedPersonality === 'string' && requestedPersonality.startsWith('Guide_')
      ? requestedPersonality
      : null;

  if (requestedPersonality !== undefined && !guideAlias) {
    if (
      typeof requestedPersonality !== 'string' ||
      !PERSONALITIES.includes(requestedPersonality as PersonalityType)
    ) {
      sendJson(res, 400, {
        error: `Invalid personality. Valid options: ${PERSONALITIES.join(', ')}`,
      });
      return;
    }
    personality = requestedPersonality as PersonalityType;
  }

  if (guideAlias) {
    personality = 'Guide';
    const aliasReligion = guideAlias.slice('Guide_'.length).toLowerCase();
    const canonicalReligion = RELIGION_ALIASES[aliasReligion] ?? aliasReligion;
    // Unknown suffix: plain Guide (buildSystemPrompt falls back to spiritual).
    religionSubType = RELIGION_KEYS.includes(canonicalReligion) ? canonicalReligion : undefined;
  }

  // religionSubType is user input injected into the system prompt — allowlist
  // only, after alias resolution (muslim -> islamic).
  if (religionSubType !== undefined) {
    const lowered = religionSubType.toLowerCase();
    const canonical = RELIGION_ALIASES[lowered] ?? lowered;
    if (!RELIGION_KEYS.includes(canonical)) {
      sendJson(res, 400, { error: 'Invalid religionSubType' });
      return;
    }
    religionSubType = canonical;
  }

  // Stranger is anonymous and topic-only: faith overlays are dropped so a
  // client can't smuggle them in.
  const isStranger = isStrangerPersonality(personality);
  if (isStranger) {
    religionSubType = undefined;
  }

  // Persona gating runs before anything billable. A 403 consumes no quota
  // and calls no provider.
  const t0 = Date.now();
  let planState: UserMessageState;
  try {
    planState = await getPlanState(uid, isDeveloper);
  } catch (error) {
    console.error(`[chat uid=${uid}] Plan lookup failed:`, error);
    sendJson(res, 500, { error: 'Internal server error' });
    return;
  }
  const plan: PlanType = planState.plan;
  const tPlan = Date.now();
  if (!isPersonalityAllowed(plan, personality)) {
    sendJson(res, 403, {
      error: `The ${personality} personality requires a paid plan. Upgrade to unlock it.`,
      code: 'persona_locked',
      plan,
      personality,
    });
    return;
  }

  // --- Env guard ---
  const { PRIMARY, FALLBACK } = getModelTargets();
  if (!PRIMARY.apiKey && !FALLBACK.apiKey) {
    console.error(`[chat uid=${uid}] Missing OPENROUTER_API_KEY and GROQ_API_KEY env vars`);
    sendJson(res, 503, { error: 'AI service unavailable', code: 'ai_key_missing' });
    return;
  }

  // --- Quota gate (before spending AI money) ---
  const quotaConfig = PLAN_CONFIG[planState.plan];
  if (!planState.unlimited && planState.messageCount >= quotaConfig.limit) {
    await writeAppLog({
      event: 'chat_quota_exhausted',
      level: 'warn',
      route: '/api/chat',
      uid,
      status: 429,
      detail: { plan: planState.plan, personality, messagesUsed: planState.messageCount },
    });
    sendJson(res, 429, {
      limitReached: true,
      code: 'quota_exhausted',
      nextRefreshAt: planState.lastResetAt + quotaConfig.refreshMs,
      showRefillTimer: true,
      messagesUsed: Math.max(0, planState.messageCount),
      messagesTotal: quotaConfig.limit,
      quotaPercent: getQuotaUsageFraction(planState.messageCount, quotaConfig.limit),
    });
    return;
  }

  // --- Attestation + throttles (independent, so run in parallel) ---
  // They run after persona gating so a 403 never burns rate-limit budget.
  const appCheckEnabled = isAppCheckEnforced();
  const throttleIp = extractClientIp(req);
  const [appCheckResult, ipThrottleResult, abuseLimitResult] = await Promise.all([
    (async (): Promise<AppCheckResult | 'skipped'> =>
      appCheckEnabled ? verifyAppCheckToken(req) : 'skipped')().catch(
      (error: unknown) => ({ __error: error }) as unknown as AppCheckResult
    ),
    (async (): Promise<unknown> => {
      if (!throttleIp) return 'ok';
      try {
        await enforceChatIpThrottle(throttleIp);
        return 'ok';
      } catch (error) {
        return error;
      }
    })(),
    (async (): Promise<unknown> => {
      try {
        await consumeRateLimit(`chat:${uid}`, CHAT_RATE_LIMIT_MAX, CHAT_RATE_LIMIT_WINDOW_MS);
        return 'ok';
      } catch (error) {
        return error;
      }
    })(),
  ]);
  const tChecks = Date.now();

  // --- Device attestation (opt-in) ---
  if (appCheckEnabled) {
    if (
      appCheckResult !== null &&
      typeof appCheckResult === 'object' &&
      '__error' in (appCheckResult as Record<string, unknown>)
    ) {
      console.error(
        '[chat] App Check verify failed (allowing request):',
        (appCheckResult as { __error: unknown }).__error
      );
    } else if (appCheckResult === 'invalid') {
      console.warn(`[chat uid=${uid.slice(0, 8)}] App Check token invalid — rejecting`);
      sendJson(res, 401, { error: 'App Check verification failed', code: 'app_check_invalid' });
      return;
    } else if (appCheckResult === 'missing') {
      console.warn(
        `[chat uid=${uid.slice(0, 8)}] App Check enabled but no token; applying IP throttle (${getChatIpRateLimitMax()}/${getChatIpRateLimitWindowMs() / 60000}min)`
      );
    }
  }

  // --- Per-IP throttle (caps farming across fresh accounts) ---
  if (ipThrottleResult instanceof RateLimitExceededError) {
    sendJson(res, 429, {
      limitReached: true,
      error: 'Too many requests, try again later',
      code: 'ip_rate_limited',
      nextRefreshAt: Date.now() + ipThrottleResult.retryAfterMs,
      showRefillTimer: false,
    });
    return;
  }
  if (ipThrottleResult !== 'ok') {
    console.error('[chat] IP throttle check failed (allowing request):', ipThrottleResult);
  }

  // --- Abuse rate limit (fail-open; plan quota still caps usage) ---
  if (abuseLimitResult instanceof RateLimitExceededError) {
    sendJson(res, 429, {
      limitReached: true,
      error: 'Too many requests, try again later',
      nextRefreshAt: Date.now() + abuseLimitResult.retryAfterMs,
      showRefillTimer: false,
    });
    return;
  }
  if (abuseLimitResult !== 'ok') {
    console.error(`[chat uid=${uid}] Rate limit check failed (allowing request):`, abuseLimitResult);
  }

  const systemPrompt = buildSystemPrompt(personality, religionSubType);
  const conversationHistory = isStranger
    ? [{ role: 'user' as const, content: trimmed }]
    : buildConversationHistory(body.messages, trimmed);
  const messages = [
    { role: 'system' as const, content: systemPrompt },
    ...conversationHistory,
  ];

  // --- Streaming fast path (?stream=1 or SSE accept) ---
  if (wantsStream(req)) {
    await handleStreamedChat(res, {
      uid,
      personality,
      religionSubType,
      isStranger,
      messages,
      primary: PRIMARY,
      fallback: FALLBACK,
      clientGoneSignal,
      t0,
      tPlan,
      tChecks,
      isDeveloper,
    });
    return;
  }

  // --- Race primary and fallback, staggered ---
  // First success wins. The fallback starts CHAT_FALLBACK_STAGGER_MS after
  // the primary (or immediately on a definitive primary failure), so a hung
  // primary never blocks a fast fallback.
  const targetsToTry = PRIMARY.model === FALLBACK.model ? [PRIMARY] : [PRIMARY, FALLBACK];

  const candidates = targetsToTry.filter((t) => t.apiKey && !isModelSkipped(t.name));
  // Every candidate breaker-open: still try rather than 503 without an attempt.
  const queued = candidates.length > 0 ? candidates : targetsToTry.filter((t) => t.apiKey);

  // Resolves when the leading attempt has definitively failed, so the
  // fallback skips the rest of its stagger on a fast primary failure.
  let releaseFallback: (() => void) | null = null;
  const fallbackReleased = new Promise<void>((resolve) => {
    releaseFallback = resolve;
  });

  const attempts = queued.map((target, index) => {
    const attemptPromise = startAttempt(
      target,
      messages,
      index * CHAT_FALLBACK_STAGGER_MS,
      clientGoneSignal,
      index === 0 ? undefined : fallbackReleased
    );
    // Release the fallback only on real failure, never on success.
    if (index === 0) {
      void attemptPromise.then((result) => {
        if (attemptFailed(result)) releaseFallback?.();
      });
    }
    return attemptPromise;
  });

  let reply = '';
  let usedTarget: ModelTarget | null = null;
  if (attempts.length > 0 && !clientGoneSignal.aborted) {
    type AttemptResult = { attempt: GroqAttempt; target: ModelTarget } | null;
    const deadlineMs = AI_TIMEOUT_MS + CHAT_FALLBACK_STAGGER_MS * (attempts.length - 1) + 500;
    const firstSuccess = new Promise<AttemptResult>((resolve) => {
      let settledFailures = 0;
      attempts.forEach((p) => {
        void p.then((result) => {
          if (result?.attempt.ok && result.attempt.reply) {
            resolve(result);
          } else {
            settledFailures += 1;
            if (settledFailures === attempts.length) resolve(null);
          }
        });
      });
    });
    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), deadlineMs));
    const winner = await Promise.race([firstSuccess, timeout]);
    if (winner?.attempt.reply) {
      reply = winner.attempt.reply;
      usedTarget = winner.target;
    }
    // Observability: log every non-winning failure without blocking the reply.
    void Promise.all(attempts).then((results) => {
      for (const result of results) {
        if (!result || result === winner) continue;
        const { attempt, target } = result;
        if (attempt.ok && !attempt.reply) {
          console.error(
            `[chat uid=${uid}] Upstream returned HTTP 200 with empty content (${target.name} model=${target.model})`
          );
        } else if (!attempt.ok) {
          console.error(
            `[chat uid=${uid}] Upstream call failed (${target.name} model=${target.model} status=${attempt.status ?? 'network/timeout'})`,
            attempt.errorData
          );
        }
      }
    });
  }

  // Client gave up — no quota consumed, nothing to deliver.
  if (clientGoneSignal.aborted) {
    console.warn(`[chat uid=${uid}] Client disconnected before reply — not consuming quota`);
    logAppEvent({
      event: 'chat_client_disconnect',
      level: 'warn',
      route: '/api/chat',
      uid,
      detail: { personality, streamed: false },
    });
    return;
  }

  if (!reply) {
    console.error(
      `[chat uid=${uid}] No reply from any provider (attempts=${attempts.length}) — returning 503 ai_upstream_error`
    );
    await writeAppLog({
      event: 'chat_upstream_error',
      level: 'error',
      route: '/api/chat',
      uid,
      status: 503,
      durationMs: Date.now() - t0,
      detail: { attempts: attempts.length, personality, streamed: false },
    });
    sendJson(res, 503, { error: 'AI service unavailable', code: 'ai_upstream_error' });
    return;
  }
  if (usedTarget) {
    const tAi = Date.now();
    console.log(
      `[chat uid=${uid}] Reply served by ${usedTarget.name} (${usedTarget.model}) ` +
        `timings plan=${tPlan - t0}ms checks=${tChecks - tPlan}ms ai=${tAi - tChecks}ms total=${tAi - t0}ms`
    );
  }

  // Post-reply event log: fire-and-forget so it never delays the response.
  logAppEvent({
    event: 'chat_reply',
    route: '/api/chat',
    uid,
    status: 200,
    durationMs: Date.now() - t0,
    detail: {
      model: usedTarget?.name ?? null,
      replyLength: reply.length,
      personality,
      religionSubType: religionSubType ?? null,
      isStranger,
      isDeveloper,
    },
  });

  sendJson(res, 200, {
    reply,
    personality,
    religionSubType: religionSubType ?? null,
    ...(isStranger
      ? { isStranger: true, anonymous: true, storeHistory: false, noHistory: true }
      : {}),
    // Legacy OpenAI-style shape alongside `reply` for old app builds.
    choices: [{ message: { role: 'assistant' as const, content: reply } }],
  });

  // Quota is persisted after the reply is flushed (TTFB unaffected) but
  // awaited — otherwise serverless freeze can drop the increment. The
  // pre-AI gate above is the instant 429; this is pure accounting.
  try {
    await consumeMessage(uid, isDeveloper);
  } catch (error: unknown) {
    if (error instanceof LimitReachedError) {
      console.warn(`[chat uid=${uid}] Quota filled during generation (reply already sent)`);
      return;
    }
    console.error(`[chat uid=${uid}] Message quota consume failed:`, error);
  }
}

interface StreamContext {
  uid: string;
  personality: PersonalityType;
  religionSubType: string | undefined;
  isStranger: boolean;
  messages: { role: string; content: string }[];
  primary: ModelTarget;
  fallback: ModelTarget;
  clientGoneSignal: AbortSignal;
  t0: number;
  tPlan: number;
  tChecks: number;
  isDeveloper: boolean;
}

/**
 * Token-streaming variant. Events: { token } per chunk, then
 * { done, reply, personality, choices }, then [DONE]. Failures arrive as an
 * { error, code } event (headers already sent as 200). Race rules mirror the
 * buffered path: first token wins, the loser is aborted and not recorded as
 * a breaker failure.
 */
async function handleStreamedChat(res: Response, ctx: StreamContext): Promise<void> {
  const { uid, personality, religionSubType, isStranger, messages, isDeveloper } = ctx;
  const { primary, fallback, clientGoneSignal } = ctx;

  const targetsToTry = primary.model === fallback.model ? [primary] : [primary, fallback];
  const candidates = targetsToTry.filter((t) => t.apiKey && !isModelSkipped(t.name));
  const queued =
    candidates.length > 0 ? candidates : targetsToTry.filter((t) => t.apiKey);
  if (queued.length === 0 || clientGoneSignal.aborted) {
    if (!clientGoneSignal.aborted) {
      console.error(`[chat uid=${uid}] No stream reply (no providers) — 503 ai_upstream_error`);
      await writeAppLog({
        event: 'chat_upstream_error',
        level: 'error',
        route: '/api/chat',
        uid,
        status: 503,
        detail: { personality, streamed: true, attempts: 0 },
      });
      sendJson(res, 503, { error: 'AI service unavailable', code: 'ai_upstream_error' });
    }
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const flushable = res as unknown as { flushHeaders?: () => void };
  if (typeof flushable.flushHeaders === 'function') flushable.flushHeaders();

  const sendEvent = (data: unknown): void => {
    if (!res.writableEnded && !res.destroyed) res.write(`data: ${JSON.stringify(data)}\n\n`);
  };
  const endStream = (): void => {
    if (!res.writableEnded && !res.destroyed) {
      res.write('data: [DONE]\n\n');
      res.end();
    }
  };

  interface Slot {
    target: ModelTarget;
    controller: AbortController;
    started: boolean;
    raceAborted: boolean;
    tokens: number;
  }
  const slots: Slot[] = queued.map((target) => ({
    target,
    controller: new AbortController(),
    started: false,
    raceAborted: false,
    tokens: 0,
  }));
  const onClientGone = () => {
    for (const slot of slots) slot.controller.abort();
  };
  if (clientGoneSignal.aborted) {
    console.warn(`[chat uid=${uid}] Client disconnected before stream — not consuming quota`);
    return;
  }
  clientGoneSignal.addEventListener('abort', onClientGone, { once: true });

  let winner: ModelTarget | null = null;
  let fullReply = '';
  let firstTokenAt = 0;
  let resolveFirstToken: () => void = () => undefined;
  const firstTokenPromise = new Promise<void>((resolve) => {
    resolveFirstToken = resolve;
  });

  const runSlot = async (slot: Slot): Promise<GroqAttempt & { target: ModelTarget }> => {
    slot.started = true;
    const attempt = await streamAttempt(slot.target, messages, {
      signal: slot.controller.signal,
      onFirstToken: () => {
        if (firstTokenAt === 0) firstTokenAt = Date.now();
        if (winner === null) {
          winner = slot.target;
          resolveFirstToken();
          // Abort the loser before it emits anything meaningful.
          for (const other of slots) {
            if (other !== slot && other.started && !other.controller.signal.aborted) {
              other.raceAborted = true;
              other.controller.abort();
            }
          }
        }
      },
      onToken: (token: string) => {
        if (winner === null) winner = slot.target;
        if (winner === slot.target) {
          slot.tokens += 1;
          fullReply += token;
          sendEvent({ token });
        }
      },
    });
    return { ...attempt, target: slot.target };
  };

  try {
    const primarySlot = slots[0];
    const primaryPromise = runSlot(primarySlot);
    void primaryPromise.then((result) => {
      if ((!result.ok || !result.reply) && winner === null) resolveFirstToken();
    });

    let fallbackPromise: Promise<GroqAttempt & { target: ModelTarget }> | null = null;
    if (slots[1]) {
      const fallbackSlot = slots[1];
      // Start the fallback on stagger expiry or definitive primary failure —
      // never once the primary is already streaming.
      const gate = await Promise.race([
        delay(CHAT_FALLBACK_STAGGER_MS).then(() => 'stagger' as const),
        firstTokenPromise.then(() => 'settled' as const),
        primaryPromise.then(() => 'settled' as const),
      ]);
      if (gate === 'stagger' && winner === null && !clientGoneSignal.aborted) {
        fallbackPromise = runSlot(fallbackSlot);
      } else if (gate === 'settled' && winner === null && !clientGoneSignal.aborted) {
        // Primary failed without a first token: record it and start the
        // fallback now instead of waiting out the stagger.
        const primaryResult = await primaryPromise;
        recordModelResult(primarySlot.target.name, false);
        if (!primaryResult.ok) {
          console.error(
            `[chat uid=${uid}] Stream primary failed (${primarySlot.target.name} status=${primaryResult.status ?? 'network/timeout'}) — failing over`
          );
        }
        fallbackPromise = runSlot(fallbackSlot);
      }
      // else: primary already streaming — fallback never starts.
      }

    const deadlineMs =
      AI_TIMEOUT_MS + CHAT_FALLBACK_STAGGER_MS * (slots.length - 1) + 500;
    const allDone = (async () => {
      const primaryResult = await primaryPromise;
      if (fallbackPromise) {
        const fallbackResult = await fallbackPromise;
        return { primaryResult, fallbackResult };
      }
      return { primaryResult, fallbackResult: null };
    })();
    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), deadlineMs));
    const settled = await Promise.race([allDone, timeout]);
    if (settled === null) {
      for (const slot of slots) {
        if (slot.started && !slot.controller.signal.aborted) {
          slot.raceAborted = true;
          slot.controller.abort();
        }
      }
    }

    if (clientGoneSignal.aborted) {
      // Tokens were already streamed (provider billed, user saw value), so
      // the quota still counts — otherwise aborts after the first token
      // would farm free previews.
      if (fullReply) {
        try {
          await consumeMessage(uid, isDeveloper);
        } catch (error: unknown) {
          if (!(error instanceof LimitReachedError)) {
            console.error(`[chat uid=${uid}] Message quota consume failed:`, error);
          }
        }
      } else {
        console.warn(`[chat uid=${uid}] Client disconnected mid-stream — not consuming quota`);
      }
      return;
    }

    // Breaker bookkeeping with race context: winner counts as success; a
    // loser aborted by the race is not a failure.
    const won = winner as ModelTarget | null;
    if (!fullReply || won === null) {
      console.error(
        `[chat uid=${uid}] No stream reply from any provider — sending error event`
      );
      await writeAppLog({
        event: 'chat_upstream_error',
        level: 'error',
        route: '/api/chat',
        uid,
        status: 200,
        detail: { personality, streamed: true, attempts: slots.length },
      });
      sendEvent({ error: 'AI service unavailable', code: 'ai_upstream_error' });
      endStream();
      return;
    }
    recordModelResult(won.name, true);
    for (const slot of slots) {
      if (slot.target === won || !slot.started || slot.tokens > 0) continue;
      if (!slot.raceAborted) recordModelResult(slot.target.name, false);
    }

    const tAi = Date.now();
    const ttft = firstTokenAt > 0 ? firstTokenAt - ctx.tChecks : tAi - ctx.tChecks;
    console.log(
      `[chat uid=${uid}] Stream reply by ${won.name} (${won.model}) ` +
        `timings plan=${ctx.tPlan - ctx.t0}ms checks=${ctx.tChecks - ctx.tPlan}ms ` +
        `ttft=${ttft}ms total=${tAi - ctx.t0}ms`
    );

    logAppEvent({
      event: 'chat_reply',
      route: '/api/chat',
      uid,
      status: 200,
      durationMs: tAi - ctx.t0,
      detail: {
        model: won.name,
        replyLength: fullReply.length,
        ttftMs: ttft,
        personality,
        religionSubType: religionSubType ?? null,
        isStranger,
        isDeveloper,
        streamed: true,
      },
    });

    // Persist quota before closing the stream so serverless freeze can't
    // drop the write. Tokens already streamed, so this only delays `done`
    // by one Firestore write.
    try {
      await consumeMessage(uid, isDeveloper);
    } catch (error: unknown) {
      if (error instanceof LimitReachedError) {
        console.warn(`[chat uid=${uid}] Quota filled during generation (stream already sent)`);
      } else {
        console.error(`[chat uid=${uid}] Message quota consume failed:`, error);
      }
    }

    sendEvent({
      done: true,
      reply: fullReply,
      personality,
      religionSubType: religionSubType ?? null,
      ...(isStranger
        ? { isStranger: true, anonymous: true, storeHistory: false, noHistory: true }
        : {}),
      choices: [{ message: { role: 'assistant' as const, content: fullReply } }],
    });
    endStream();
  } finally {
    clientGoneSignal.removeEventListener('abort', onClientGone);
  }
}
