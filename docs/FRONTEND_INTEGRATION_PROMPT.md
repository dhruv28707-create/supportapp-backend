# SAFESPACE Frontend — Integration Prompt (backend-hardened edition)

You are building the client (mobile/web frontend) for the SAFESPACE emotional-support app backend
(supportapp-backend). This backend has gone through a full security audit; **8 hardening classes**
are enforced server-side. This prompt is written so the app you build (a) works smoothly against
the hardened backend and (b) never re-opens one of the holes the client could accidentally reopen.
Whatever isn't explicitly allowed below, don't do — the server will reject it with a specific code
you can map to UI.

---

## A. The 8 backend-hardened issues → what the CLIENT must do

These rules are not stylistic. Each one keeps a server-side defense effective, and each has a
matching error code / UX path so the app stays smooth.

### Issue 1 — fresh-account & trial-farming abuse (server: durable anti-churn ledger, server-only plan docs)
*Server behavior:* one free trial per account ever, enforced by a `trialGuards` ledger keyed by uid
AND hashed email that **survives** account deletion + same-email re-signup. Plan/quota state lives
only in server-only Firestore (`subscriptions/{uid}`) — nothing about plans/trials can be read or
written client-side in Firestore.

**Client rules:**
- Trial eligibility is decided ONLY by `POST /api/trial/start` responses:
  200 → granted; `403 trial_not_eligible` → account too old, show shop/upgrade instead;
  `409 trial_already_used` → no second trial, ever (don't offer a CTA again for that identity);
  `409 already_subscribed` → they're paying already, route to plan management;
  `409 developer_account` → already has Ultimate, no trial UI.
- **Never** implement client-side "delete + re-register to get a new trial" flows or shortcuts, and
  never hint at them in the UI. The backend refuses them and the extra deletions will grind the
  user's data in vain and trip per-IP throttles.
- After deletion success, fully sign out. A same-email re-signup is a **brand new user** — run it
  through normal onboarding; it will simply not get a new trial.
- Trust only fetched state (`GET /api/user/usage`); never cache plan/trial flags across app
  restarts or compose local expectations from token claims.

### Issue 2 — quota is a hard cap now; bursts can't bypass it (server: transactional consume)
*Server behavior:* the pre-AI gate is a fast-fail 429; the true cap is enforced transactionally when
the reply is returned. A reply that got generated can still land after the cap was reached — quota
accounting happens server-side, atomically, only once per delivered reply.

**Client rules (this is the big one for smooth UX):**
- **Serialize chat: ONE in-flight chat request per user, ever.** Disable the send button (or queue
  the draft) from t0 until the response/screens event/best-effort stream completes (success or
  error). Parallel sends only burn the user's own 30/5min abuse budget and can produce several
  "quota exhausted" toasts.
- Treat `429 code:"quota_exhausted"` as the quota screen: show `messagesUsed/messagesTotal`,
  `quotaPercent`, and the refill countdown **only if `showRefillTimer === true`** (the 75% rule —
  below that the server says the timer is noise; hiding it is correct, not a bug).
- Distinguish limit-driven vs abuse-driven 429s: quota errors carry `code:"quota_exhausted"` /
  `messagesUsed`… ; other 429s carry `error:"Too many requests, try again later"` (that's the
  30/5min per-uid chat limiter or a per-IP throttle) → generic "you're sending too fast, hold on",
  with retry after ≥ 60s. **Never auto-retry a 429 immediately.**
- Upstream failure (`503 ai_upstream_error`) is retry-safe — quota was NOT consumed. Auto-retry at
  most once after ~2s, then hand the "service unavailable" state to the user.
- Refetch `/api/user/usage` after any 429/200 chat cycle refresh — don't compute `remaining`
  client-side from your own counter (server is the source of truth; refunds/downgrades can move it
  either way).

### Issue 3 — bodies must not be compressed; payloads are size-capped (server: bounded streaming gunzip for the drain, raw wire-byte HMAC)
*Server behavior:* API request bodies are read as raw wire bytes. A separate recipient endpoint
(`/api/logs/vercel`, server-to-server) enforces 2 MB raw / 10 MB decompressed. Client requests are
plain JSON.

**Client rules:**
- **Never set `Content-Encoding` on any request** (don't gzip request bodies, don't configure your
  networking/caching layer or a "request compression" interceptor to do it). Supported values would
  be rejected for API clients; unsupported values get `415`.
- Keep chat request bodies small anyway: the contract caps history (see Issue 5). Oversized
  payloads get `413`.
- Frontend must never call `/api/logs/vercel` — that's a Vercel drain receiver with HMAC
  authentication. Hand-crafted or mirrored "telemetry" from the client will just 403/413.

### Issue 4 — zero Identity-Toolkit pressure; state reads are refreshed sparingly (server: creationTime cached server-side)
*Server behavior:* `/api/user/plan` and `/api/user/usage` no longer hit Firebase Auth per read, but
they still hit Firestore; plan reads are always **fresh** (no stale cache), so treat them as cheap
but not free.

**Client rules:**
- Fetch plan state at: app start (screen), after each chat turn, after trial-start, after
  payment-verify/cancel, after resume-from-background — **not** on every keystroke, tab switch or
  render.
- If you want background refresh, intervals ≥ 60s, with one shared in-flight request (a poll loop
  that fires while the previous one is pending, or retries that ignore throttles, is a hammer).
- `trialAvailable` can only be true/updated after a fresh fetch — never infer it locally from
  account age or token claims.
- Handle `500` from usage/plan as transient: show stale last-known data with a subtle "refreshing…"
  retry affordance instead of error toasts.

### Issue 5 — history budget is tight and server-enforced (server: 16 turns, 500 chars/turn, 4000 chars total)
*Server behavior:* client `messages[]` history is allowlisted (`user`/`assistant` only), each turn
≤ 500 chars, total history ≤ 4000 chars, max 16 turns, and scan-bounded at 50 entries. Over-long or
invalid entries are **silently dropped** (no error) — the model just won't see them. The live
`message` keeps its own 2000-char allowance.

**Client rules:**
- Send at most the last ~6–10 **short** turns (≤ 500 chars each). Truncate *your own stored
  transcript* before sending; don't paste full transcripts into `message` or `messages`.
- Never send roles other than `user`/`assistant` (especially never `system`) — invalid entries get
  dropped, and a UI that claims "context sent" while it wasn't will look broken.
- If a turn gets truncated client-side, let the truncation happen naturally in UI (e.g., summarize
  or send a fresh-typed message) instead of stuffing long text into history.
- **Stranger persona = no history, no persistence**: omit `messages` entirely, and honor the
  response's `storeHistory:false/noHistory:true` by not writing the turn to your local DB either.
- Don't build "prompt-injection-shaped" input handlers (e.g., letting users paste a system prompt,
  persona rules, or "remember the following instructions" as history). It gets neutralized upstream
  and just wastes the 4000-char budget (and your users' conversation quality).

### Issue 6 — throttle keys are peer-derived; headers are not client input (server: req.ip wins, header fallback only when absent)
*Server behavior:* on the Vercel runtime the client IP key = connection peer address; the
`x-vercel-forwarded-for` header is ignored for keying. Forwarding headers never work as "overriding"
input from the client.

**Client rules:**
- **Never send or rely on** `x-forwarded-for`, `x-vercel-forwarded-for`, or any proxy/relay header
  from the app. If a user is behind a shared VPN/NAT, per-IP limits are shared by design — that's
  normal, don't "work around" it (there's nothing to work around; headers are ignored anyway).
- Don't introduce reverse-proxy hops or webview weirdness that strips/synthesizes connection
  metadata — nothing to gain; the key is derived from the socket.
- If you ever see indiscriminate 429 `ip_rate_limited` across different accounts on one network
  (campus NAT etc.), that's the shared-budget design — surface "you've hit the network limit" with
  the countdown, not a bug report door.

### Issue 7 — secrets never live in the client (server: dedicated IP_HASH_SECRET, never a payment secret)
*Server behavior:* all HMAC/secret material is server-side. The only secret-shaped value the
client holds is the **public** Razorpay `KeyId`.

**Client rules:**
- Embed **no backend secrets** in the app binary or env-bundled JS: no `IP_HASH_SECRET`,
  no `RAZORPAY_WEBHOOK_SECRET`, no Firebase admin/service-account material, no AI provider keys.
- Razorpay checkout uses ONLY the `keyId` returned by `POST /api/payment-order`.
- Never compute/save/verify a signature client-side (the `razorpaySignature` you pass to
  payment-verify must be exactly what the Razorpay SDK produced — don't mutate or recalculate it).
- Anything that needs a secret belongs on the backend; if a new feature seems to need one, add a
  backend endpoint, not client crypto.

### Issue 8 — provider failures come with a global cooldown (server: circuit breakers shared across the fleet)
*Server behavior:* after repeated upstream failures the backend stops calling a dead AI provider
fleet-wide for ~60s, then half-open probes it again. Clients feel this as occasional 503s during a
provider outage.

**Client rules (don't turn an outage into a request storm):**
- On `503 ai_upstream_error` (or a mid-stream `error` event): show "AI is briefly unavailable,
  retrying shortly…". Delay manual retry by ≥ 15–30s; auto-retry at most ONE time after ~2s in a
  session before deferring to user-initiated retry.
- **Never** auto-retry 503s in a tight loop or fire several parallel retries — every retry
  hammers the (possibly dead) upstream or re-spends the challenger budget against the cooldown and
  delays recovery for everyone.
- While a breaker may be open, alternative features (e.g., history browsing) must keep working —
  only the composer shows a disabled/refusal state, never a full app lockout.

---

## B. Golden rules (always true)

1. Identity is the Firebase ID token ONLY: `Authorization: Bearer <idToken>` on every call. Never
   send uid/`isDeveloper`/plan/trial flags anywhere — the server ignores or rejects them.
2. Firestore is read-only for you, and only at client-allowed paths (`users/{uid}` profile fields).
   Quota/plan/trial truth lives in server-only collections (`subscriptions/{uid}`, `payments/{id}`,
   `trialGuards/*`, `rateLimits/*`, `ipLimits/*`, `appLogs/*`) — using those client-side breaks the
   security boundary by definition.
3. All money amounts (`amount` in paise), tier names, plan names, prices, and feature checks are
   **server values** (`/api/plans`, order/verify responses). Never compute or persist amounts.
4. 401 → refresh/re-auth the ID token and retry ONCE, then sign the user out for real (revocations
   are server-side and expected after deletion).
5. 429 always means "slow down", never "retry now". Backoff ≥ 60s unless the body gives you a
   specific `nextRefreshAt` (epoch ms) — then wait until it; show a countdown if the payload says so.

## C. Firebase / App Check setup

- ID token: attach `Authorization: Bearer <idToken>`; proactively refresh (e.g., on app resume,
  before any call that got 401).
- App Check header on chat calls (and payment calls if you choose to enforce broadly):
  `x-firebase-appcheck: <token>`. Not enforced at missing-token stage today, but **install it now**
  so the gradual rollout never rejects your users. If the server flips to single-use mode
  (`APP_CHECK_CONSUME=true`), generate a FRESH App Check token for every request.

## D. Endpoint contracts

| Endpoint | Method | Auth | Notes |
|---|---|---|---|
| `/api/health` | GET | none | Liveness + firebase status |
| `/api/plans` | GET | none | Choice cards: `{ currency: 'INR', options[] }` — read all price labels from here |
| `/api/diagnose` | GET | gated by `ENABLE_DIAGNOSE` | Ops diagnostics, do not surface in-app to end users |
| `/api/user/usage` | GET | Bearer | Preferred quota read (see §E) |
| `/api/user/plan` | GET | Bearer | Legacy compat — same shape as usage (without uiHints) |
| `/api/chat`, `/api/chat/send` | POST | Bearer | See §F |
| `/api/trial/start` | POST | Bearer | See §G |
| `/api/payment-order` | POST | Bearer | `{ tier }` → `{ orderId, amount, currency, keyId }` |
| `/api/payment-verify` | POST | Bearer | Razorpay callback verify (idempotent) |
| `/api/payment-cancel` | POST | Bearer | `{ ok, message }`, idempotent |
| `/api/account` | DELETE | Bearer | Full deletion; see §H |

## E. Plan/quota state (GET /api/user/usage)

```json
{
  "plan": "free|pro|ultimate",
  "messagesUsed": 3, "messagesRemaining": 17, "messagesTotal": 20,
  "quotaPercent": 15,
  "nextRefreshAt": 1799913600000, "refillInMs": 3500000, "refreshHours": 5,
  "isLimitReached": false, "showRefillTimer": false,
  "expiresAt": null,
  "isTrial": true, "trialEndsAt": 179900000, "trialUsed": false,
  "trialAvailable": true,
  "isDeveloper": false, "unlimited": false,
  "uiHints": { "showQuotaInUsageOnly": true, "hideQuotaInLobby": true, "hideQuotaInChat": true }
}
```

- Plan windows: **free 20/5h, pro 80/4h, ultimate 200/2h** (`refreshHours` is per plan).
- Only show the refill countdown when `showRefillTimer === true` (≥ 75% used or limit hit).
- `isDeveloper/unlimited` → hide all quota UI entirely.
- `trialAvailable` → only show the trial CTA on free, never-trialed accounts then confirm
  eligibility with the `POST /api/trial/start` result (see Issue 1 rules).

## F. Chat

Request:
```json
{
  "message": "<the live user turn, 1..2000 chars>",
  "personality": "Friend",
  "religionSubType": "islamic",
  "messages": [{ "role": "user", "content": "short past turn" },
               { "role": "assistant", "content": "short past reply" }]
}
```
Memory caps: ≤ 16 turns, ≤ 500 chars/turn, ≤ 4000 chars history total. Send ~6-10 recent turns.
(See Issue 5's rules.)

**Non-stream (200):**
```json
{ "reply": "…", "personality": "Friend", "religionSubType": null,
  "choices": [{ "message": { "role": "assistant", "content": "…" } }] }
```
Stranger extras: `isStranger: true, anonymous: true, storeHistory: false, noHistory: true`.

**Error surface (exact codes):**
| Status | Body code | UI |
|---|---|---|
| 400 | `message must be a string`/length | inline composer validation |
| 400 | `Invalid personality. Valid options: …` | fix the persona palette |
| 400 | `Invalid religionSubType` | drop the subtype, retry with plain Guide |
| 403 | `persona_locked` (+ `plan`, `personality`) | upgrade sheet |
| 429 | `quota_exhausted` (w/ messagesUsed/Total, quotaPercent, nextRefreshAt, showRefillTimer) | quota/upgrade screen |
| 429 | `ip_rate_limited` or `Too many requests…` | "hold on" retry state (≥60s) |
| 503 | `ai_upstream_error` / `ai_key_missing` | retry section: Issue 8 rules |
| 501/else | — | generic error, keep composer intact |

**Streaming (recommended):** set `Accept: text/event-stream` (or `?stream=1`).
```
data: {"token":"…"}                    // incremental chunks
data: {"done":true,"reply":"full text","personality":"…","religionSubType":null,"choices":[…]}
data: [DONE]
```
- Render incrementally from tokens; treat `done.reply` as the FINAL text.
- `{"error":"…","code":"ai_upstream_error"}` mid-stream → same retry UI as 503.
- Client disconnect is server-detected: tokens already streamed still consume quota; a disconnect
  before tokens doesn't. Don't confuse either user with quota messages in-flight; refresh usage
  after completion.

## G. Trial (POST /api/trial/start)

- 200 `{ success, isTrial, plan: 'ultimate', trialDays: 5, startedAt, trialEndsAt, expiresAt }`
- `403 trial_not_eligible` (new-accounts-only, age window 7 days) → route to upgrade; never a retry.
- `409 trial_already_used` / `already_subscribed` / `developer_account`.
- Per-uid 5/10min, per-IP 10/10min throttles → respect 429.
- Timing: derive the countdown from `trialEndsAt` (epoch ms) after every refresh.

## H. Payments (Razorpay)

- `POST /api/payment-order {"tier": "pro_monthly|pro_yearly|ultimate_monthly|ultimate_yearly"}`
  → `{ orderId, amount (paise), currency: 'INR', keyId }`. Server-side prices: pro_monthly ₹179,
  pro_yearly ₹699, ultimate_monthly ₹199, ultimate_yearly ₹799 (always trust the API, not constants).
- Checkout: use `amount`, `currency` and `keyId` straight from the order response.
- `POST /api/payment-verify { razorpayOrderId, razorpayPaymentId, razorpaySignature }` →
  `{ success, plan, expiresAt, alreadyVerified? }` (idempotent — double-callbacks are fine).
- Server verifies signature, order ownership, capture status, and matches the amount/tier —
  never shortcut with client-computed values.
- `POST /api/payment-cancel` idempotent: `{ ok: true, message: "Subscription cancelled" }`.
- Order route throttles: 10/10min per uid, 20/10min per IP, max 5 unverified orders per user
  (409/429 with plain English errors).

## I. Account deletion (DELETE /api/account)

- Pre-checks: `403 { code: 'developer_account' }` (operator revoke required),
  `409 { code: 'active_subscription', expiresAt }` (cancel subscription first),
  `409` typed as `{ error, expiresAt }` from the second gate.
- 200 `{ success, deleted: { subscription, userDoc, pendingPayments }, anonymizedPayments,
  chatsDeleted, firebaseAuthDeleted, durationMs }` → hard sign out (refresh tokens revoked server
  side; anything after this returns 401).
- 500 → deletion did NOT remove data; show "service issue, try again" — safe to retry.

## J. Suggested flow (same as the backend's design)

```
app open → GET /api/user/usage (once, then after turns/trial/payments)
 ├─ unlimited → chat
 ├─ isTrial → full SD grid + trial banner (trialEndsAt)
 ├─ isLimitReached → refill/upgrade (countdown only if showRefillTimer)
 ├─ free && !trialUsed && trialAvailable → trial CTA
 └─ else → free persona palette (locked → upgrade sheet)

chat send → ONE in-flight request (serialize!) → on completion refresh usage
 ├─ 200/SSE done → render (respect noHistory)
 ├─ 429 quota_exhausted → quota screen         ├─ 429 other → cool-down banner
 ├─ 403 persona_locked → upgrade               ├─ 503 → one auto-retry, then user retry ≥15s
 └─ 401 → refresh token ×1 → else re-login
```

Follow the flow above exactly and the app will be smooth; every deviation has a specific server
response that maps cleanly to the UI destination named for it.
