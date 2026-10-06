import { Request, Response } from 'express';
import { AI_TIMEOUT_MS } from '../constants';
import { razorpay } from '../services/razorpayClient';

/**
 * Diagnostic endpoint (no secrets exposed). Disabled by default — set
 * ENABLE_DIAGNOSE=true to turn it on. Live probes (?test=1, ?rzp=1) cost
 * real provider money, so they need the admin token too.
 */
export async function diagnoseHandler(req: Request, res: Response): Promise<void> {
  if (process.env.ENABLE_DIAGNOSE !== 'true') {
    res.status(404).json({ error: 'Not found' });
    return;
  }

  // Read lazily per request so model overrides take effect without restart.
  const primaryProvider =
    (process.env.CHAT_PRIMARY_PROVIDER || '').toLowerCase() === 'openrouter'
      ? 'openrouter'
      : 'groq';
  const groqModel =
    process.env.GROQ_MODEL || process.env.FALLBACK_MODEL || 'openai/gpt-oss-20b';
  const openRouterModel =
    process.env.OPENROUTER_MODEL || process.env.PRIMARY_MODEL || 'qwen/qwen3-14b';
  const primaryModel = primaryProvider === 'groq' ? groqModel : openRouterModel;
  const fallbackModel = primaryProvider === 'groq' ? openRouterModel : groqModel;

  const env = {
    OPENROUTER_API_KEY: Boolean(process.env.OPENROUTER_API_KEY),
    GROQ_API_KEY: Boolean(process.env.GROQ_API_KEY),
    PRIMARY_MODEL: process.env.PRIMARY_MODEL || null,
    FALLBACK_MODEL: process.env.FALLBACK_MODEL || null,
    GROQ_MODEL: process.env.GROQ_MODEL || null,
    OPENROUTER_MODEL: process.env.OPENROUTER_MODEL || null,
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
    primaryProvider,
    primaryModel,
    fallbackModel,
    env,
  };

  // Live Razorpay self-test: ?rzp=1 creates a minimal ₹1 order (never paid).
  // Gated: unauthenticated callers could otherwise mint unlimited orders
  // against the live key. Requires x-diagnose-token == DIAGNOSE_ADMIN_TOKEN.
  if (req.query.rzp === '1') {
    const adminToken = process.env.DIAGNOSE_ADMIN_TOKEN || '';
    const provided = String(req.headers['x-diagnose-token'] || '');
    if (!adminToken || provided !== adminToken) {
      res.status(403).json({ ...base, rzpTest: { ok: false, error: 'Forbidden' } });
      return;
    }
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

  // Live Groq probe (?test=1). Gated like ?rzp=1: without the admin token
  // anyone could burn AI spend through this endpoint.
  if (req.query.test !== '1') {
    res.json({ ...base, note: 'Pass ?test=1 to run a live Groq API check (128 max tokens).' });
    return;
  }

  const adminToken = process.env.DIAGNOSE_ADMIN_TOKEN || '';
  const provided = String(req.headers['x-diagnose-token'] || '');
  if (!adminToken || provided !== adminToken) {
    res.status(403).json({ ...base, groqTest: { ok: false, error: 'Forbidden' } });
    return;
  }

  if (!process.env.GROQ_API_KEY) {
    res.json({ ...base, groqTest: { ok: false, error: 'GROQ_API_KEY is not set' } });
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: groqModel,
        messages: [{ role: 'user', content: 'Reply with the single word: OK' }],
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
