import { Request, Response } from 'express';
import { GROQ_TIMEOUT_MS } from '../constants';

const GROQ_MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';

/**
 * Diagnostic endpoint (no secrets exposed).
 *
 * GET /api/diagnose
 *   Reports which required env vars are present, plus the active Groq model.
 *
 * GET /api/diagnose?test=1
 *   Additionally performs a live 1-token Groq API call and reports the exact
 *   upstream status — this pinpoints whether the AI failure is a missing key,
 *   an invalid/out-of-credits key, or a model-level error.
 *
 * Deliberately does NOT depend on Firebase, so it still works when the rest of
 * the backend is misconfigured.
 */
export async function diagnoseHandler(req: Request, res: Response): Promise<void> {
  const env = {
    GROQ_API_KEY: Boolean(process.env.GROQ_API_KEY),
    GROQ_MODEL: process.env.GROQ_MODEL || null,
    FIREBASE_PROJECT_ID: Boolean(process.env.FIREBASE_PROJECT_ID),
    FIREBASE_CLIENT_EMAIL: Boolean(process.env.FIREBASE_CLIENT_EMAIL),
    FIREBASE_PRIVATE_KEY: Boolean(process.env.FIREBASE_PRIVATE_KEY),
    RAZORPAY_KEY_ID: Boolean(process.env.RAZORPAY_KEY_ID),
    RAZORPAY_KEY_SECRET: Boolean(process.env.RAZORPAY_KEY_SECRET),
    RAZORPAY_WEBHOOK_SECRET: Boolean(process.env.RAZORPAY_WEBHOOK_SECRET),
  };

  const base = {
    ok: true,
    service: 'supportapp-backend',
    time: new Date().toISOString(),
    groqModel: GROQ_MODEL,
    env,
  };

  if (req.query.test !== '1') {
    res.json({ ...base, note: 'Pass ?test=1 to run a live 1-token Groq API check.' });
    return;
  }

  if (!process.env.GROQ_API_KEY) {
    res.json({ ...base, groqTest: { ok: false, error: 'GROQ_API_KEY is not set' } });
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GROQ_TIMEOUT_MS);
  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [{ role: 'user', content: 'Reply with the single word: OK' }],
        max_tokens: 5,
        temperature: 0,
      }),
      signal: controller.signal,
    });

    const body = (await response.json().catch(() => null)) as {
      error?: { message?: string };
      choices?: Array<{ message?: { content?: string } }>;
    } | null;

    const errorMessage = response.ok
      ? null
      : body?.error?.message || (body ? JSON.stringify(body) : 'Non-JSON error response');

    res.json({
      ...base,
      groqTest: {
        ok: response.ok,
        status: response.status,
        error: errorMessage,
        reply: response.ok ? body?.choices?.[0]?.message?.content || null : null,
      },
    });
  } catch (error) {
    res.json({
      ...base,
      groqTest: {
        ok: false,
        status: null,
        error: String((error as Error).message || error),
      },
    });
  } finally {
    clearTimeout(timer);
  }
}
