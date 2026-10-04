import { Response, Request } from 'express';
import {
  PersonalityType,
  PERSONALITIES,
  LimitReachedError,
  AI_TIMEOUT_MS,
  CHAT_FALLBACK_STAGGER_MS,
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

interface ModelTarget {
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  // Extra body fields merged into the request (used to suppress any
  // hidden chain-of-thought output on models that support a reasoning mode).
  extraBody?: Record<string, unknown>;
}

/**
 * Groq (gpt-oss-20b). Chosen as the default PRIMARY because it is markedly
 * faster to first token than OpenRouter's Qwen3-14B — the model the user is
 * waiting on should be the quick one.
 * `GROQ_MODEL` is the clear name; `FALLBACK_MODEL` is the legacy name kept so
 * existing deployments keep working after the provider order was flipped.
 */
function groqTarget(): ModelTarget {
  return {
    name: 'groq',
    baseUrl: 'https://api.groq.com/openai/v1/chat/completions',
    apiKey: process.env.GROQ_API_KEY || '',
    model: process.env.GROQ_MODEL || process.env.FALLBACK_MODEL || 'openai/gpt-oss-20b',
    // reasoning_effort low: gpt-oss reasoning adds 10-40% latency per Groq's
    // own guide — low keeps quality while cutting decode time.
    // service_tier on_demand: guaranteed processing for realtime chat, never
    // queued behind flex/batch throughput workloads.
    extraBody: { reasoning_effort: 'low', service_tier: 'on_demand' },
  };
}

/**
 * OpenRouter (Qwen3-14B). Slower but stronger — now the FALLBACK, so it only
 * answers when Groq is down or hung.
 * `OPENROUTER_MODEL` is the clear name; `PRIMARY_MODEL` is the legacy alias.
 */
function openRouterTarget(): ModelTarget {
  return {
    name: 'openrouter',
    baseUrl: process.env.PRIMARY_BASE_URL || 'https://openrouter.ai/api/v1/chat/completions',
    apiKey: process.env.PRIMARY_API_KEY || process.env.OPENROUTER_API_KEY || '',
    model: process.env.OPENROUTER_MODEL || process.env.PRIMARY_MODEL || 'qwen/qwen3-14b',
    extraBody: { reasoning: { enabled: false } },
  };
}

/**
 * Which provider answers first. Defaults to Groq because response latency is
 * dominated by the primary model's generation time, and gpt-oss-20b on Groq
 * is far quicker than Qwen3-14B on OpenRouter. Set
 * CHAT_PRIMARY_PROVIDER=openrouter to restore the old order.
 */
function primaryProvider(): 'groq' | 'openrouter' {
  return (process.env.CHAT_PRIMARY_PROVIDER || '').toLowerCase() === 'openrouter'
    ? 'openrouter'
    : 'groq';
}

/**
 * Reads provider keys/targets lazily (per request) so tests can stub env vars
 * with vi.stubEnv AFTER the module was imported. Module-level
 * `process.env.X` captures would freeze the import-time value (usually
 * undefined in tests) and break every chat test with ai_key_missing.
 */
function getModelTargets(): { PRIMARY: ModelTarget; FALLBACK: ModelTarget } {
  const groq = groqTarget();
  const openRouter = openRouterTarget();
  return primaryProvider() === 'openrouter'
    ? { PRIMARY: openRouter, FALLBACK: groq }
    : { PRIMARY: groq, FALLBACK: openRouter };
}
// Both models are plain instruct models (no hidden reasoning tokens), so the
// budget goes straight to the visible reply. The system prompt asks for
// short, human-scale replies (mostly 1-3 sentences, ~60-120 tokens); 300 is
// a generous ceiling that still caps runaway responses without mid-sentence
// truncation.
//
// Keep this tight: generation time scales LINEARLY with tokens emitted
// (Groq: Total = TTFT + output_tokens/speed + network), so every extra 100
// tokens is ~0.2-0.5s of user-visible wait. 600 cost us ~1-2s extra on long
// replies for zero quality gain on 1-3 sentence answers.
const MAX_TOKENS = 300;
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

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * Never rejects — resolves { attempt, target } or null on failure.
 *
 * `releaseEarly` lets a queued attempt skip the rest of its delay the moment
 * an earlier attempt has DEFINITIVELY failed (network error, HTTP error, or
 * empty body). That removes the pointless dead time where a dead primary
 * errors in 200ms but the fallback still sat waiting for the full stagger.
 * A slow-but-healthy primary deliberately does NOT release the fallback —
 * that would double-bill tokens on every merely-sluggish request.
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
  // Absolute guarantee against unhandled rejections: attempts never reject.
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
 * Streams one completion attempt, forwarding tokens via onToken as they
 * arrive. Resolves with the full reply (or failure). Never throws.
 *
 * First-token latency is what the user FEELS: with `stream:true` Groq sends
 * the first token in ~300-600ms while the full 6s generation is still
 * running — the app renders progressively instead of staring at a spinner.
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
      response = (await fetch(target.baseUrl, {
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
          ...(target.extraBody || {}),
        }),
        signal: controller.signal,
      })) as unknown as globalThis.Response;
    } catch (error: unknown) {
      return { ok: false, status: undefined, errorData: error };
    }

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      return { ok: false, status: response.status, errorData };
    }
    const body = response.body;
    if (!body) {
      // Provider ignored stream:true and returned no body — treat as failure
      // so the caller can fall back to the buffered path.
      return { ok: false, status: response.status, errorData: 'empty stream body' };
    }

    let full = '';
    let gotFirst = false;
    let buffer = '';
    const decoder = new TextDecoder();
    const stream = body as unknown as AsyncIterable<Uint8Array>;
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
        if (delta) {
          if (!gotFirst) {
            gotFirst = true;
            opts.onFirstToken();
          }
          full += delta;
          opts.onToken(delta);
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
          if (delta) {
            if (!gotFirst) {
              gotFirst = true;
              opts.onFirstToken();
            }
            full += delta;
            opts.onToken(delta);
          }
        } catch {
          // ignore trailing garbage
        }
      }
    }
    // NOTE: no recordModelResult here — the streaming race aborts the loser
    // mid-flight, and an aborted-healthy provider must NOT count as a
    // breaker failure. The caller records results with race context.
    return { ok: full.length > 0, reply: full };
  } catch (error) {
    return { ok: false, status: undefined, errorData: error };
  } finally {
    clearTimeout(timer);
    if (opts.signal) opts.signal.removeEventListener('abort', onExternalAbort);
  }
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
  //
  // IMPORTANT: listen on the RESPONSE, not `req.socket`. On serverless
  // runtimes (Vercel/Lambda) the request socket is a synthetic stream that
  // emits 'close' as soon as the request body has been read — not when the
  // client disconnects — so a `req.socket` listener aborts EVERY request
  // before the AI call and the handler returns without ever writing a
  // response (users saw a generic "try again later" while the logs stayed
  // silent). `res` 'close' fires when the connection actually ends; a fully
  // written response (`writableEnded`) is not a disconnect.
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

  // --- Server-side persona gating (the frontend UI lock is cosmetic) ---
  // A 403 here must NOT consume quota and must NOT call any AI provider.
  // Runs BEFORE the env guard so a locked persona reports persona_locked
  // (403) even when provider keys are missing.
  //
  // Timing: t0 anchors per-stage breakdown logged with the reply, so the
  // next "why is it slow" question is answered by data (Firestore vs
  // provider vs network) instead of guesses.
  const t0 = Date.now();
  let plan: PlanType;
  try {
    plan = (await getPlanState(uid)).plan;
  } catch (error) {
    console.error(`[chat uid=${uid}] Plan lookup failed:`, error);
    sendJson(res, 500, { error: 'Internal server error' });
    return;
  }
  const tPlan = Date.now();
  if (!isPersonalityAllowed(plan, personality)) {
    sendJson(res, 403, {
      error: `The ${personality} personality requires a Pro plan. Upgrade to unlock it.`,
      code: 'persona_locked',
      plan,
      personality,
    });
    return;
  }

  // --- Env guard (fail with a clear error instead of a crash) ---
  const { PRIMARY, FALLBACK } = getModelTargets();
  if (!PRIMARY.apiKey && !FALLBACK.apiKey) {
    console.error(`[chat uid=${uid}] Missing OPENROUTER_API_KEY and GROQ_API_KEY env vars`);
    sendJson(res, 503, { error: 'AI service unavailable', code: 'ai_key_missing' });
    return;
  }

  // --- Attestation + throttles, IN PARALLEL ---
  // These three are independent (App Check verify, per-IP Firestore counter,
  // per-uid rate-limit counter), so awaiting them sequentially stacked
  // ~200-400ms EACH onto every message. Promise.all pays only the slowest
  // one (~one Firestore round-trip). They run AFTER persona gating so a
  // 403 never burns rate-limit quota.
  const appCheckEnabled = isAppCheckEnforced();
  const throttleIp = extractClientIp(req);
  const [appCheckResult, ipThrottleResult, abuseLimitResult] = await Promise.all([
    (async (): Promise<AppCheckResult | 'skipped'> =>
      appCheckEnabled ? verifyAppCheckToken(req) : 'skipped')().catch(
      (error: unknown) => ({ __error: error }) as unknown as AppCheckResult
    ),
    (async (): Promise<'ok' | RateLimitExceededError | unknown> => {
      if (!throttleIp) return 'ok';
      try {
        await enforceChatIpThrottle(throttleIp);
        return 'ok';
      } catch (error) {
        return error;
      }
    })(),
    (async (): Promise<'ok' | RateLimitExceededError | unknown> => {
      try {
        await consumeRateLimit(`chat:${uid}`, CHAT_RATE_LIMIT_MAX, CHAT_RATE_LIMIT_WINDOW_MS);
        return 'ok';
      } catch (error) {
        return error;
      }
    })(),
  ]);
  const tChecks = Date.now();

  // --- Device attestation (opt-in; see appCheckService.ts) ---
  // Creating Firebase accounts is free, so uid-keyed quotas alone cannot cap
  // the AI bill: one script can farm thousands of accounts. When
  // ENABLE_APP_CHECK=true, invalid App Check tokens are rejected and missing
  // tokens fall through to the (much tighter) IP throttle below.
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
        `[chat uid=${uid.slice(0, 8)}] App Check enabled but no token; applying IP throttle (${CHAT_IP_RATE_LIMIT_MAX}/${CHAT_IP_RATE_LIMIT_WINDOW_MS / 60000}min)`
      );
    }
  }

  // --- Per-IP throttle: caps free-signup farming from one address ---
  // Independent of (and in addition to) the per-uid limit below. See
  // chatClientThrottle.ts for why it is IP-based and what the limits mean.
  if (ipThrottleResult instanceof RateLimitExceededError) {
    sendJson(res, 429, {
      limitReached: true,
      error: 'Too many requests, try again later',
      code: 'ip_rate_limited',
      nextRefreshAt: Date.now() + ipThrottleResult.retryAfterMs,
    });
    return;
  }
  if (ipThrottleResult !== 'ok') {
    console.error('[chat] IP throttle check failed (allowing request):', ipThrottleResult);
  }

  // --- Abuse rate limit (independent of the plan message quota) ---
  // Fail-open on limiter storage errors (consistent with the payment
  // limiters): availability beats throttling when the limiter itself is
  // broken — plan quota below still caps usage.
  if (abuseLimitResult instanceof RateLimitExceededError) {
    sendJson(res, 429, {
      limitReached: true,
      error: 'Too many requests, try again later',
      nextRefreshAt: Date.now() + abuseLimitResult.retryAfterMs,
    });
    return;
  }
  if (abuseLimitResult !== 'ok') {
    console.error(`[chat uid=${uid}] Rate limit check failed (allowing request):`, abuseLimitResult);
  }

  const systemPrompt = buildSystemPrompt(personality, religionSubType);
  const messages = [
    { role: 'system' as const, content: systemPrompt },
    { role: 'user' as const, content: trimmed },
  ];

  // --- Streaming fast path (progressive render) ---
  // ?stream=1 (or Accept: text/event-stream). First token reaches the client
  // in ~0.5s while generation continues — a 6s reply becomes "already
  // reading" instead of "staring at a spinner". Backward compatible: the
  // default path below keeps the exact buffered JSON shape, so existing
  // apps and all tests are untouched until the frontend opts in.
  if (wantsStream(req)) {
    await handleStreamedChat(res, {
      uid,
      personality,
      religionSubType,
      messages,
      primary: PRIMARY,
      fallback: FALLBACK,
      clientGoneSignal,
      t0,
      tPlan,
      tChecks,
    });
    return;
  }

  // --- Race primary and fallback STAGGERED IN PARALLEL ---
  // First success wins: the fallback starts CHAT_FALLBACK_STAGGER_MS after the
  // primary, so a slow-but-healthy primary can still win, but a HUNG primary
  // never blocks a fast fallback (the old sequential `for await` waited out
  // the full AI_TIMEOUT_MS on primary even when fallback had already
  // succeeded — mobile clients abort ~10s and saw "AI not responding").
  //
  // The stagger is small (500ms) so the fallback still lands inside the
  // user's patience window; it is not near-zero because firing the fallback
  // on EVERY request would double-bill tokens when the primary is merely a
  // little slow.
  //
  // And when the primary fails FAST (bad key, 5xx, network error) the
  // fallback doesn't wait out the stagger at all — it is released the moment
  // the primary settles without a reply, so a dead primary costs the user
  // only the provider's error time, not 500ms of dead air on top of it.
  const targetsToTry = PRIMARY.model === FALLBACK.model ? [PRIMARY] : [PRIMARY, FALLBACK];

  const candidates = targetsToTry.filter((t) => t.apiKey && !isModelSkipped(t.name));
  // If every candidate is breaker-open, still try (half-open probes resolve
  // this naturally on the next cooldown expiry, but never return 503 without
  // at least one real attempt).
  const queued = candidates.length > 0 ? candidates : targetsToTry.filter((t) => t.apiKey);

  // Resolves when the leading attempt has definitively failed. Later attempts
  // race their stagger against this so a fast failure fails over immediately.
  // The executor runs synchronously, so `releaseFallback` is assigned before
  // anything can read it.
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
    // The first attempt is the one that gates the fallback: release it only
    // on a real failure, never on success (which would waste tokens).
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
    // Worst case: the last attempt starts at (n-1) x stagger and may itself
    // run the full timeout. Keep this equal to the real abort point — a
    // tighter deadline only risks 503-ing an attempt that was about to
    // succeed, so lower AI_TIMEOUT_MS itself when latency must drop.
    const deadlineMs = AI_TIMEOUT_MS + CHAT_FALLBACK_STAGGER_MS * (attempts.length - 1) + 500;
    const firstSuccess = new Promise<AttemptResult>((resolve) => {
      let settledFailures = 0;
      attempts.forEach((p) => {
        p.then((result) => {
          if (result && result.attempt.ok && result.attempt.reply) {
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
    if (winner && winner.attempt.reply) {
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

  // The client (or its proxy) gave up — do not consume quota, do not attempt
  // to deliver. Return quietly; the socket is already closed.
  if (clientGoneSignal.aborted) {
    console.warn(`[chat uid=${uid}] Client disconnected before reply — not consuming quota`);
    return;
  }

  if (!reply) {
    // Log synchronously BEFORE responding: the detached observability chain
    // below may not flush before a serverless instance freezes, and a silent
    // 503 is what made this look like "users fail but logs are clean".
    console.error(
      `[chat uid=${uid}] No reply from any provider (attempts=${attempts.length}) — returning 503 ai_upstream_error`
    );
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

interface StreamContext {
  uid: string;
  personality: PersonalityType;
  religionSubType: string | undefined;
  messages: { role: string; content: string }[];
  primary: ModelTarget;
  fallback: ModelTarget;
  clientGoneSignal: AbortSignal;
  t0: number;
  tPlan: number;
  tChecks: number;
}

/**
 * Token-streaming variant of the chat race (see wantsStream).
 *
 * Protocol (SSE, `data: <json>` per event):
 *   { token: "..." }   — one per generated chunk, append to the bubble
 *   { done: true, reply, personality, choices } — full reply + metadata
 *   [DONE]              — stream terminator (OpenAI convention)
 *   { error, code }     — headers already sent as 200, so failures arrive
 *                         as an event, not a status code
 *
 * Race rules mirror the buffered path: the fallback starts CHAT_FALLBACK_
 * STAGGER_MS after the primary ONLY if the primary hasn't produced a first
 * token yet (healthy primary = zero double-bill), or immediately on a
 * definitive primary failure. First token wins; the loser is aborted and —
 * critically — never recorded as a breaker failure.
 */
async function handleStreamedChat(res: Response, ctx: StreamContext): Promise<void> {
  const { uid, personality, religionSubType, messages } = ctx;
  const { primary, fallback, clientGoneSignal } = ctx;

  const targetsToTry = primary.model === fallback.model ? [primary] : [primary, fallback];
  const candidates = targetsToTry.filter((t) => t.apiKey && !isModelSkipped(t.name));
  const queued =
    candidates.length > 0 ? candidates : targetsToTry.filter((t) => t.apiKey);
  if (queued.length === 0 || clientGoneSignal.aborted) {
    if (!clientGoneSignal.aborted) {
      console.error(`[chat uid=${uid}] No stream reply (no providers) — 503 ai_upstream_error`);
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
  // Flush headers NOW so the client's first-token clock starts before the
  // provider round-trip, not after it.
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
  let resolveFirstToken: () => void = () => {};
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
      // Wait for the stagger — unless the primary already won (first token)
      // or definitively failed (fail fast, no dead air).
      const gate = await Promise.race([
        delay(CHAT_FALLBACK_STAGGER_MS).then(() => 'stagger' as const),
        firstTokenPromise.then(() => 'settled' as const),
        primaryPromise.then(() => 'settled' as const),
      ]);
      if (gate === 'stagger' && winner === null && !clientGoneSignal.aborted) {
        fallbackPromise = runSlot(fallbackSlot);
      } else if (gate === 'settled' && winner === null && !clientGoneSignal.aborted) {
        // Primary settled without a first token = definitive failure: record
        // it and start the fallback NOW instead of waiting out the stagger.
        const primaryResult = await primaryPromise;
        recordModelResult(primarySlot.target.name, false);
        if (!primaryResult.ok) {
          console.error(
            `[chat uid=${uid}] Stream primary failed (${primarySlot.target.name} status=${primaryResult.status ?? 'network/timeout'}) — failing over`
          );
        }
        fallbackPromise = runSlot(fallbackSlot);
      }
      // else: primary already streaming tokens — fallback never starts.
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
      console.warn(`[chat uid=${uid}] Client disconnected mid-stream — not consuming quota`);
      return;
    }

    // Breaker bookkeeping with race context: the winner counts as success;
    // a started-but-tokenless loser aborted BY THE RACE is not a failure.
    // (winner is assigned only inside stream callbacks, so copy to a const
    // (winner is assigned only inside stream callbacks, so read it through
    // a cast — narrowing would otherwise collapse it to null/never.)
    const won = winner as ModelTarget | null;
    if (!fullReply || won === null) {
      console.error(
        `[chat uid=${uid}] No stream reply from any provider — sending error event`
      );
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

    // Only now consume quota — a failed stream never burns the allowance.
    try {
      await consumeMessage(uid);
    } catch (error) {
      if (error instanceof LimitReachedError) {
        sendEvent({ error: 'Message limit reached', code: 'limit_reached', limitReached: true });
        endStream();
        return;
      }
      console.error(`[chat uid=${uid}] Message quota consume failed:`, error);
      sendEvent({ error: 'Internal server error', code: 'quota_error' });
      endStream();
      return;
    }

    sendEvent({
      done: true,
      reply: fullReply,
      personality,
      religionSubType: religionSubType ?? null,
      choices: [{ message: { role: 'assistant' as const, content: fullReply } }],
    });
    endStream();
  } finally {
    clientGoneSignal.removeEventListener('abort', onClientGone);
  }
}
