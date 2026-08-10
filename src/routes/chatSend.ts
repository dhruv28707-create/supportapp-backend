import { Response } from 'express';
import { PersonalityType, PERSONALITIES } from '../constants';
import { buildSystemPrompt, RELIGION_KEYS } from '../services/promptService';
import { checkMessageQuota, consumeMessage } from '../services/messageService';
import { LimitReachedError } from '../constants';
import { AuthenticatedRequest } from '../middleware/authMiddleware';

const GROQ_API_KEY = process.env.GROQ_API_KEY;
// Model is overridable via env; defaults to a current Groq production model.
// (llama-3.3-70b-versatile was retired on 2026-08-16.)
const GROQ_MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';
const MAX_TOKENS = 500;
const MAX_MESSAGE_LENGTH = 4000;

export async function chatSendHandler(req: AuthenticatedRequest, res: Response): Promise<void> {
  const uid = req.user!.uid;
  const { message, personality, religionSubType } = (req.body || {}) as {
    message?: unknown;
    personality?: unknown;
    religionSubType?: unknown;
  };

  // --- Input validation ---
  if (typeof message !== 'string') {
    res.status(400).json({ error: 'message must be a string' });
    return;
  }
  const trimmed = message.trim();
  if (trimmed.length < 1 || trimmed.length > MAX_MESSAGE_LENGTH) {
    res.status(400).json({ error: `message must be 1-${MAX_MESSAGE_LENGTH} characters` });
    return;
  }

  if (typeof personality !== 'string' || !PERSONALITIES.includes(personality as PersonalityType)) {
    res.status(400).json({ error: 'Invalid personality' });
    return;
  }

  // religionSubType is user input injected into the system prompt — allowlist only.
  if (religionSubType !== undefined) {
    if (
      typeof religionSubType !== 'string' ||
      !RELIGION_KEYS.includes(religionSubType.toLowerCase())
    ) {
      res.status(400).json({ error: 'Invalid religionSubType' });
      return;
    }
  }

  // --- Env guard (fail with a clear error instead of a crash) ---
  if (!GROQ_API_KEY) {
    console.error('Missing GROQ_API_KEY environment variable');
    res.status(503).json({ error: 'AI service unavailable' });
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
    console.error('Message quota check failed:', error);
    res.status(500).json({ error: 'Internal server error' });
    return;
  }

  const systemPrompt = buildSystemPrompt(
    personality as PersonalityType,
    typeof religionSubType === 'string' ? religionSubType : undefined
  );
  const messages = [
    { role: 'system' as const, content: systemPrompt },
    { role: 'user' as const, content: trimmed },
  ];

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages,
        max_tokens: MAX_TOKENS,
        temperature: 0.8,
      }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      console.error('GroqCloud API error:', response.status, errorData);
      res.status(503).json({ error: 'AI service unavailable' });
      return;
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const reply = data.choices?.[0]?.message?.content?.trim() || '';

    if (!reply) {
      res.status(503).json({ error: 'AI service unavailable' });
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
      console.error('Message quota consume failed:', error);
      res.status(500).json({ error: 'Internal server error' });
      return;
    }

    res.json({ reply });
  } catch (error) {
    console.error('Chat send error:', error);
    res.status(503).json({ error: 'AI service unavailable' });
  }
}
