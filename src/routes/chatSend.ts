import { Response } from 'express';
import { PersonalityType, PERSONALITIES } from '../constants';
import { buildSystemPrompt, RELIGION_KEYS } from '../services/promptService';
import { checkMessageQuota, consumeMessage } from '../services/messageService';
import { LimitReachedError } from '../constants';
import { AuthenticatedRequest } from '../middleware/authMiddleware';
import { GROQ_TIMEOUT_MS } from '../constants';

const GROQ_API_KEY = process.env.GROQ_API_KEY;
// Primary model — overridable via env; defaults to a current Groq production model.
// (llama-3.3-70b-versatile was retired on 2026-08-16.)
const PRIMARY_MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';
// Fallback model used when the primary call fails (retired model, model-level
// error, transient upstream failure). llama-3.1-8b-instant is a long-running
// stable Groq production model — lower quality than the primary, but it keeps
// chat alive through model changes.
const FALLBACK_MODEL = 'llama-3.1-8b-instant';
// gpt-oss-120b is a reasoning model: it consumes part of the token budget on
// hidden reasoning before producing the visible reply (seen via
// completion_tokens_details.reasoning_tokens). 500 tokens was too small —
// reasoning could eat it all and leave an empty reply. 2000 gives reasoning
// room while staying fast on Groq (~500+ t/s) and inside Vercel's limits.
const MAX_TOKENS = 2000;
const MAX_MESSAGE_LENGTH = 4000;

interface GroqAttempt {
  ok: boolean;
  status?: number;
  errorData?: unknown;
  reply?: string;
}

/** Single Groq completion attempt. Never throws — failures are returned. */
async function callGroq(
  model: string,
  messages: { role: string; content: string }[]
): Promise<GroqAttempt> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GROQ_TIMEOUT_MS);
  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: MAX_TOKENS,
        temperature: 0.8,
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
  if (!GROQ_API_KEY) {
    console.error(`[chat uid=${uid}] Missing GROQ_API_KEY environment variable`);
    res.status(503).json({ error: 'AI service unavailable', code: 'groq_key_missing' });
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
  const modelsToTry =
    FALLBACK_MODEL === PRIMARY_MODEL ? [PRIMARY_MODEL] : [PRIMARY_MODEL, FALLBACK_MODEL];

  let reply = '';
  for (const model of modelsToTry) {
    const attempt = await callGroq(model, messages);
    if (attempt.ok && attempt.reply) {
      reply = attempt.reply;
      break;
    }
    if (attempt.ok) {
      // HTTP 200 but no content — e.g. the token budget was hit before any
      // text was produced, or the model filtered the response.
      console.error(
        `[chat uid=${uid}] Groq returned HTTP 200 with empty content (model=${model})`
      );
    } else {
      console.error(
        `[chat uid=${uid}] Groq call failed (model=${model} status=${attempt.status ?? 'network/timeout'})`,
        attempt.errorData
      );
    }
  }

  if (!reply) {
    res.status(503).json({ error: 'AI service unavailable', code: 'groq_upstream_error' });
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
