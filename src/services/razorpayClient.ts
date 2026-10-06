import axios from 'axios';
import Razorpay from 'razorpay';

/**
 * Razorpay client with a 10s call budget. The SDK's axios instance defaults
 * to no timeout, which would hang until the platform kills the function.
 */
export const RAZORPAY_TIMEOUT_MS = 10000;

function buildClient(): Razorpay {
  const key_id = process.env.RAZORPAY_KEY_ID;
  const key_secret = process.env.RAZORPAY_KEY_SECRET;
  if (!key_id || !key_secret) {
    throw new Error(
      'Missing RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET environment variables — payments are disabled'
    );
  }
  // The SDK merges axios global defaults into its own instance at
  // construction, so set the timeout only around `new Razorpay(...)`.
  const previousTimeout = axios.defaults.timeout;
  axios.defaults.timeout = RAZORPAY_TIMEOUT_MS;
  try {
    return new Razorpay({ key_id, key_secret });
  } finally {
    axios.defaults.timeout = previousTimeout;
  }
}

// Lazy singleton via Proxy: keys are read on first use, not import, so env
// stubs and rotation take effect without a restart.
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
