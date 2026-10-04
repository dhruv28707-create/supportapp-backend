import axios from 'axios';
import Razorpay from 'razorpay';

/**
 * Timeout for Razorpay API calls. The Razorpay SDK wraps axios, which
 * defaults to NO timeout (timeout: 0) — a stalled upstream call would hang
 * until the hosting platform kills the function (Vercel maxDuration = 60s),
 * which users experience as endless buffering before the checkout opens.
 * Mirror the 10s budget used for Groq calls so payments fail fast with a
 * clear error instead.
 */
export const RAZORPAY_TIMEOUT_MS = 10000;

function buildClient(): Razorpay {
  const key_id = process.env.RAZORPAY_KEY_ID;
  const key_secret = process.env.RAZORPAY_KEY_SECRET;
  // Descriptive (not `process.env.X!`): the old non-null assertion crashed
  // cold-start imports with an inscrutable TypeError. This throws a clear
  // error only when the client is actually USED without keys.
  if (!key_id || !key_secret) {
    throw new Error(
      'Missing RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET environment variables — payments are disabled'
    );
  }
  // The SDK builds its axios instance inside `new Razorpay(...)` and merges
  // axios' global defaults into it. Set the default timeout ONLY around the
  // construction, then restore — the old code mutated the GLOBAL axios
  // defaults permanently, throttling every other axios client in the process.
  const previousTimeout = axios.defaults.timeout;
  axios.defaults.timeout = RAZORPAY_TIMEOUT_MS;
  try {
    return new Razorpay({ key_id, key_secret });
  } finally {
    axios.defaults.timeout = previousTimeout;
  }
}

// Lazy singleton via Proxy: keys are read on first USE (not import), so tests
// can vi.stubEnv AFTER import and production gets a clear error only when
// payments are actually attempted without keys.
let cached: Razorpay | null = null;
function real(): Razorpay {
  if (!cached) cached = buildClient();
  return cached;
}

export const razorpay: Razorpay = new Proxy({} as Razorpay, {
  get(_target, prop, receiver) {
    const instance = real() as unknown as Record<string | symbol, unknown>;
    const value = instance[prop as string];
    if (typeof value === 'object' && value !== null) return value;
    if (typeof value === 'function')
      return (value as (...args: unknown[]) => unknown).bind(instance);
    return Reflect.get(instance, prop, receiver);
  },
});
