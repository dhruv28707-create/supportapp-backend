import { Response } from 'express';
import { PersonalityType, PERSONALITIES } from '../constants';
import { buildSystemPrompt, RELIGION_KEYS } from '../services/promptService';
import { checkMessageQuota, consumeMessage } from '../services/messageService';
import { LimitReachedError } from '../constants';
import { AuthenticatedRequest } from '../middleware/authMiddleware';
import { GROQ_TIMEOUT_MS } from '../constants';

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
// replacement; reasoning_effort:'none' keeps every token a visible reply.
const FALLBACK: ModelTarget = {
  name: 'fallback',
  baseUrl: 'https://api.groq.com/openai/v1/chat/completions',
  apiKey: GROQ_API_KEY || '',
  model: process.env.FALLBACK_MODEL || 'openai/gpt-oss-20b',
  extraBody: { reasoning_effort: 'none' },
};
// Both models are plain instruct models (no hidden reasoning tokens), so the
// budget goes straight to the visible reply. The system prompt asks for 2-4
// short sentences (~120 tokens); 600 is a generous ceiling (roughly 450 words)
// that still caps runaway responses without mid-sentence truncation.
const MAX_TOKENS = 600;
const MAX_MESSAGE_LENGTH = 4000;

interface GroqAttempt {
  ok: boolean;
  status?: number;
  errorData?: unknown;
  reply?: string;
}

/** Single completion attempt against a model target. Never throws — failures are returned. */
async function callModel(
  target: ModelTarget,
  messages: { role: string; content: string }[]
): Promise<GroqAttempt> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GROQ_TIMEOUT_MS);
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
    return { ok: true, reply: data.choices?.[0]?.message?.content?.trim() || '' };
  } catch (error) {
    return { ok: false, status: undefined, errorData: error };
  } finally {
    clearTimeout(timer);
  }
}

export async function chatSendHandler(req: AuthenticatedRequest, res: Response): Promise<void> {
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
    res.status(400).json({ error: 'message must be a string' });
    return;
  }
  const trimmed = rawMessage.trim();
  if (trimmed.length < 1 || trimmed.length > MAX_MESSAGE_LENGTH) {
    res.status(400).json({ error: `message must be 1-${MAX_MESSAGE_LENGTH} characters` });
    return;
  }

  // Legacy app payloads may not send a personality — default to Friend
  // (the same fallback buildSystemPrompt uses) instead of rejecting.
  const personality: PersonalityType =
    typeof body.personality === 'string' &&
    PERSONALITIES.includes(body.personality as PersonalityType)
      ? (body.personality as PersonalityType)
      : 'Friend';

  // religionSubType is user input injected into the system prompt — allowlist only.
  if (body.religionSubType !== undefined) {
    if (
      typeof body.religionSubType !== 'string' ||
      !RELIGION_KEYS.includes(body.religionSubType.toLowerCase())
    ) {
      res.status(400).json({ error: 'Invalid religionSubType' });
      return;
    }
  }

  // --- Env guard (fail with a clear error instead of a crash) ---
  if (!PRIMARY.apiKey && !FALLBACK.apiKey) {
    console.error(`[chat uid=${uid}] Missing OPENROUTER_API_KEY and GROQ_API_KEY env vars`);
    res.status(503).json({ error: 'AI service unavailable', code: 'ai_key_missing' });
    return;
  }

  // --- Message quota check (does NOT consume yet; consumed only on AI success) ---
  try {
    await checkMessageQuota(uid);
  } catch (error) {
    if (error instanceof LimitReachedError) {
      res.status(429).json({
        limitReached: true,
        nextRefreshAt: error.nextRefreshAt,
      });
      return;
    }
    console.error(`[chat uid=${uid}] Message quota check failed:`, error);
    res.status(500).json({ error: 'Internal server error' });
    return;
  }

  const systemPrompt = buildSystemPrompt(
    personality,
    typeof body.religionSubType === 'string' ? body.religionSubType : undefined
  );
  const messages = [
    { role: 'system' as const, content: systemPrompt },
    { role: 'user' as const, content: trimmed },
  ];

  // --- Try primary model, then fall back to a secondary model ---
  const targetsToTry = PRIMARY.model === FALLBACK.model ? [PRIMARY] : [PRIMARY, FALLBACK];

  let reply = '';
  for (const target of targetsToTry) {
    const attempt = await callModel(target, messages);
    if (attempt.ok && attempt.reply) {
      reply = attempt.reply;
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

  if (!reply) {
    res.status(503).json({ error: 'AI service unavailable', code: 'ai_upstream_error' });
    return;
  }

  // AI responded successfully — only now consume a message from the quota.
  try {
    await consumeMessage(uid);
  } catch (error) {
    if (error instanceof LimitReachedError) {
      res.status(429).json({
        limitReached: true,
        nextRefreshAt: error.nextRefreshAt,
      });
      return;
    }
    console.error(`[chat uid=${uid}] Message quota consume failed:`, error);
    res.status(500).json({ error: 'Internal server error' });
    return;
  }

  res.json({
    reply,
    // Legacy app builds parse the raw OpenAI-style shape
    // (data.choices[0].message.content) instead of data.reply — return both
    // so old and new app versions both work.
    choices: [{ message: { role: 'assistant' as const, content: reply } }],
  });
}
