# SAFESPACE Backend

Backend for **SAFESPACE** — an emotional support chat app with 12 AI personalities, optional spiritual guidance overlays, and Razorpay-powered subscriptions (freemium).

- **Runtime:** Node.js >= 18 (uses native `fetch`), TypeScript (strict)
- **Hosting:** Vercel serverless functions (`api/`) — the same handlers also run as an Express app (`src/index.ts`) for local/self-hosted use
- **AI:** Qwen3-14B via OpenRouter (primary) → GPT-OSS-20B via Groq (fallback)
- **Auth:** Firebase ID tokens (`Authorization: Bearer <idToken>`)
- **Data:** Firestore (quotas, subscriptions, payments)
- **Payments:** Razorpay orders + checkout verification + webhooks

## Quick start

```bash
npm install
cp .env.example .env    # fill in real values
npm run dev             # Express server on :3000 (ts-node)
```

Other scripts:

| Script | What it does |
|---|---|
| `npm run build` | Compile `src/` → `dist/` |
| `npm run lint` | Lint `src/` with ESLint (includes type-aware rules) |
| `npm run typecheck` | Type-check without emitting (`tsc --noEmit`) |
| `npm run sanity` | Run `scripts/sanity-check.ts` (verifies tier prices/mappings) |
| `npm start` | Run the compiled Express app from `dist/` |

Deploy on Vercel: the functions in `api/` are compiled by Vercel's runtime; set all env vars in Project Settings.

## Architecture note

Every endpoint exists twice by design:

- `api/*.ts` — thin serverless wrappers for Vercel. They share CORS/preflight/method-check/auth boilerplate via `src/apiWrapper.ts`.
- `src/routes/*` — the actual handler logic, shared verbatim by both the Vercel functions and the Express app in `src/index.ts`.

## API reference

Base URL (Vercel): `https://<your-project>.vercel.app`

All responses are JSON. Errors use the shape `{ "error": "<message>" }`.

### GET /api/health

Liveness probe. No auth.

```json
{ "status": "ok", "service": "supportapp-backend" }
```

### POST /api/chat

Chat with an AI persona. **Auth required.**

Request body:

```json
{
  "message": "I've had a rough day",
  "personality": "Mother",
  "religionSubType": "islamic"
}
```

| Field | Rules |
|---|---|
| `message` | Required string, 1–4000 chars. Legacy clients may instead send `messages: [...]` (OpenAI-style); only the latest user turn is used — there is no server-side conversation memory. |
| `personality` | Optional. One of `Father`, `Mother`, `Sister`, `Brother`, `Friend`, `Best Friend`, `Mentor`, `Guide`, `Husband`, `Wife`, `Boyfriend`, `Girlfriend`. Omitted → defaults to `Friend`. Invalid value → **400** with the list of valid options. `Guide_<religion>` (e.g. `Guide_hindu`) is accepted as an alias for `personality: "Guide"` + `religionSubType` |
| `religionSubType` | Optional. Only used when `personality` is `Guide`. One of `islamic`, `hindu`, `christian`, `buddhist`, `jewish`, `spiritual`, `secular`. Invalid value → 400. |

**Persona gating is enforced server-side.** Free plans can use the family & friend personas (`Father`, `Mother`, `Sister`, `Brother`, `Friend`, `Best Friend`); the rest (`Mentor`, `Guide`, `Husband`, `Wife`, `Boyfriend`, `Girlfriend`) require an active pro/ultimate plan. A locked persona returns **403** `{ code: 'persona_locked', plan, personality }` and consumes no quota. The frontend's UI locks are cosmetic only.

Success response:

```json
{
  "reply": "Oh beta, that sounds heavy...",
  "personality": "Mother",
  "religionSubType": null,
  "choices": [{ "message": { "role": "assistant", "content": "...same as reply..." } }]
}
```

`reply` and `choices[0].message.content` carry the same text; `choices` exists for legacy clients. Echoed `personality`/`religionSubType` let you confirm which persona answered.

Errors:

| Status | Meaning |
|---|---|
| 400 | Missing/invalid message, personality, or religionSubType |
| 403 | Persona not allowed on the user's plan (`code: 'persona_locked'`) |
| 429 | Message quota exhausted → `{ limitReached: true, nextRefreshAt }` (epoch ms) — also used by the abuse rate limiter (30 requests / 5 min / user, fail-open) |
| 503 | AI upstream unavailable (`code: 'ai_key_missing'` or `'ai_upstream_error'`) — quota is never consumed on 503 | |

Quota is consumed **only** after a successful AI reply.

### GET /api/user/plan

Current plan and quota state. **Auth required.**

```json
{
  "plan": "free",
  "messagesRemaining": 17,
  "nextRefreshAt": 1756160000000,
  "isLimitReached": false
}
```

Plan limits (`src/constants.ts`): free 20 msgs / 5h · pro 80 / 4h · ultimate 200 / 2h.

### POST /api/payment-order

Create a Razorpay order for a subscription tier. **Auth required.** Rate limited to 10 / 10 min / user.

```json
{ "tier": "pro_monthly" }
```

Tiers & prices: `pro_monthly` ₹179 · `pro_yearly` ₹699 · `ultimate_monthly` ₹199 · `ultimate_yearly` ₹799.

Response:

```json
{ "orderId": "order_xxx", "amount": 17900, "currency": "INR", "keyId": "rzp_test_xxx" }
```

`amount` is in paise; pass it to Razorpay Checkout as-is.

### POST /api/payment-verify

Verify a completed checkout and activate the plan. **Auth required.** Rate limited to 20 / 10 min / user. Idempotent — replaying a verified payment returns `200` with `alreadyVerified: true`.

```json
{
  "razorpay_order_id": "order_xxx",
  "razorpay_payment_id": "pay_xxx",
  "razorpay_signature": "..."
}
```

Response:

```json
{ "success": true, "plan": "pro", "expiresAt": "2026-09-26T00:00:00.000Z", "alreadyVerified": false }
```

Errors: 400 (missing fields, bad signature, not captured, order/amount mismatch), 403 (order belongs to another user), 404 (unknown order), 502 (Razorpay API unreachable).

### POST /api/payment-cancel

Cancel the authenticated user's subscription so the Delete Account flow is unblocked. **Auth required.** No body. Rate limited to 6 / 10 min / user.

This backend's payments are one-time Razorpay orders — there is no Razorpay subscription entity and nothing auto-renews, so cancellation is a server-side state change only.

- **No active subscription** (no doc, already cancelled, free plan, or expired): **200** `{ ok: true, message: "No active subscription found" }` — deliberately not an error, so the call is idempotent.
- **Active subscription**: cancelled **immediately** — `subscriptions/{uid}` gets `status: "cancelled"`, `plan` drops to `free` and `expiresAt` is cleared — and returns **200** `{ ok: true, message: "Subscription cancelled" }`. Paid perks end now; time already paid is forfeited.
- A **cancelled subscription no longer blocks `DELETE /api/account`**. Re-paying later re-grants normally (`status` flips back to `active`).
- If a `razorpaySubscriptionId` is ever present on the record (future recurring plans), the Razorpay cancel API is attempted best-effort first; its failure is logged and never blocks the local cancellation. Razorpay keys (`RAZORPAY_KEY_ID`/`RAZORPAY_KEY_SECRET`) stay server-side and are never exposed.

### POST /api/webhooks/razorpay

Server-to-server webhook. Verifies the HMAC-SHA256 signature over the raw body and grants plans authoritatively. Non-2xx responses trigger Razorpay retries. Processing is idempotent: a webhook and a client verify racing on the same order grant exactly once (atomic transactional status flip), and replays return `alreadyProcessed: true` / `alreadyVerified: true` without re-granting or resetting quota.

### DELETE /api/account

Delete the authenticated user's account server-side. **Auth required** (uid comes from the verified Firebase token — one user can never delete another's data). Rate limited to 3 / hour.

- **409** `{ code: 'active_subscription', expiresAt }` — deletion is blocked while a paid subscription is **active**. The user must cancel first via `POST /api/payment-cancel` (immediate downgrade), let it expire, or contact support per the refund policy; deletion must not silently bypass payment obligations. A cancelled subscription no longer blocks deletion.
- **200** on success: deletes `subscriptions/{uid}`, the `users/{uid}` profile doc, rate-limit counters and pending payment orders; **anonymizes** paid payment rows (financial records are kept, uid redacted); revokes all Firebase refresh tokens (existing ID tokens stop verifying within minutes) and deletes the Firebase Auth account (no-op if the client already called `currentUser.delete()`).
- The frontend may still do its client-side cleanup + `currentUser.delete()` first; this endpoint is the server-side guarantee that server data and API access are gone.

### GET /api/diagnose

Diagnostics — **disabled by default.** Set `ENABLE_DIAGNOSE=true` to enable (do this only temporarily; it reveals which secrets are configured and `?test=1` / `?rzp=1` trigger real paid-provider calls). Disabled → 404.

## Frontend integration notes

- Chat is **stateless per request**: send one `message` at a time. If you want conversational context, keep history client-side — but note the backend currently uses only your latest message plus the persona system prompt.
- On `429` with `limitReached: true`, show a "limit reached" screen counting down to `nextRefreshAt` (epoch ms).
- Payment flow: `POST /api/payment-order` → open Razorpay Checkout with `orderId`, `amount`, `currency`, `keyId` → on success call `POST /api/payment-verify` with the three checkout fields. Safe to retry verify on network failures.
- Refresh plan/quota from `GET /api/user/plan` after app resume or payment success.

## Environment variables

See [.env.example](./.env.example) for the annotated full list (Firebase Admin, OpenRouter/Groq keys with optional model overrides, Razorpay keys/webhook secret, `ALLOWED_ORIGINS`, `ENABLE_DIAGNOSE`). The example file contains no real secrets; never commit `.env`.

## Security model

- **Secrets** live only in server-side env vars (`.env` locally, Vercel dashboard in production). `.env` is git-ignored; a full-history scan pattern check is recommended after any suspected leak, and any leaked key must be rotated (Razorpay keys in the Razorpay dashboard, Firebase keys in Google Cloud, AI keys with their providers).
- **Auth**: every protected endpoint verifies the Firebase ID token (`Authorization: Bearer <token>`, revocation-checked); `uid` is always derived from the token, never from request data. Missing/invalid → **401**; authenticated but not authorized for the resource → **403**.
- **Plan trust**: plan/quota state lives in the server-only `subscriptions` collection and is granted exclusively through signature-verified payments (checkout verify + webhook, both cross-checked against Razorpay's API). A client-writable `users/{uid}` doc can never grant premium by itself.
- **Firestore rules** ([firestore.rules](./firestore.rules)): no god-account/developer override; `users/{uid}` protects `tier`/`plan`/`role`/`isDeveloper`/`premium`/quota fields from client mutation; `payments` and `subscriptions` are server-only writes; anything not explicitly matched is denied. Deploy with `firebase deploy --only firestore:rules`.
