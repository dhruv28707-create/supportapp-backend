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

// The SDK builds its axios instance inside `new Razorpay(...)` and merges
// axios' global defaults into it, so setting the default timeout before
// constructing guarantees every Razorpay request inherits it — and axios
// aborts the underlying request when the timeout fires.
axios.defaults.timeout = RAZORPAY_TIMEOUT_MS;

export const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID!,
  key_secret: process.env.RAZORPAY_KEY_SECRET!,
});
