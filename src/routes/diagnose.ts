import { Request, Response } from 'express';
import { GROQ_TIMEOUT_MS } from '../constants';
import { razorpay } from '../services/razorpayClient';

const GROQ_MODEL = process.env.GROQ_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct';

/**
 * Diagnostic endpoint (no secrets exposed).
 *
 * GET /api/diagnose
 *   Reports which required env vars are present, plus the active Groq model.
 *
 * GET /api/diagnose?test=1
 *   Additionally performs a live Groq API call (32 max tokens — small but
 *   enough for a real reply) and reports the exact upstream status, reply,
 *   finish_reason, usage, and a raw-response snippet when no content came
 *   back. This pinpoints whether the AI failure is a missing key, an
 *   invalid/out-of-credits key, a model-level error, or empty content.
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

  // Live Razorpay self-test: ?rzp=1 attempts to create a minimal ₹1 order
  // with the deployed keys and reports the exact outcome (or upstream error).
  // Never exposes the keys themselves. The order is never paid and expires.
  if (req.query.rzp === '1') {
    if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
      res.json({ ...base, rzpTest: { ok: false, error: 'RAZORPAY keys are not set' } });
      return;
    }
    const mode = process.env.RAZORPAY_KEY_ID.startsWith('rzp_live_') ? 'live' : 'test';
    try {
      const order = await razorpay.orders.create({
        amount: 100, // ₹1 — minimal, never paid
        currency: 'INR',
        receipt: `diag_${Date.now()}`,
      });
      res.json({ ...base, rzpTest: { ok: true, mode, orderId: order.id } });
    } catch (error) {
      const err = error as {
        statusCode?: number;
        error?: { code?: string; description?: string };
        message?: string;
      };
      res.json({
        ...base,
        rzpTest: {
          ok: false,
          mode,
          statusCode: err.statusCode ?? null,
          code: err.error?.code ?? null,
          description: err.error?.description ?? null,
          message: err.message ?? null,
          raw: String(error),
        },
      });
    }
    return;
  }

  if (req.query.test !== '1') {
    res.json({ ...base, note: 'Pass ?test=1 to run a live Groq API check (128 max tokens).' });
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
        // Enough for a short diagnostic reply; a healthy result should show
        // reply != null.
        max_tokens: 128,
        temperature: 0,
      }),
      signal: controller.signal,
    });

    const rawText = await response.text().catch(() => null);

    let parsed: {
      error?: { message?: string };
      choices?: Array<{
        message?: { content?: string | null };
        finish_reason?: string | null;
      }>;
      usage?: unknown;
    } | null = null;
    if (rawText) {
      try {
        parsed = JSON.parse(rawText);
      } catch {
        parsed = null;
      }
    }

    const content: string | null =
      parsed && typeof parsed.choices?.[0]?.message?.content === 'string'
        ? parsed.choices[0].message.content
        : null;

    const errorMessage = response.ok
      ? null
      : parsed?.error?.message || rawText || 'Non-JSON error response';

    res.json({
      ...base,
      groqTest: {
        ok: response.ok && content !== null,
        status: response.status,
        error: errorMessage,
        reply: content,
        finishReason: parsed?.choices?.[0]?.finish_reason ?? null,
        usage: parsed?.usage ?? null,
        rawSnippet: content === null ? (rawText ? rawText.slice(0, 500) : null) : null,
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
