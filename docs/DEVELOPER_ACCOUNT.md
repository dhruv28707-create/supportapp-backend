# Developer account (admin) — backend + frontend notes

A developer account is a normal Firebase Auth user that has been granted
server-side developer status. It gets **Ultimate + unlimited chat quota for
free** and can call the read-only `/api/developer/*` endpoints to inspect the
database and provider-key usage.

Developer status is **never** accepted from the client. It comes from one of:

1. a signed Firebase custom claim `developer: true` (preferred; set by the grant script),
2. the server-side `DEVELOPER_EMAILS` / `DEVELOPER_UIDS` allowlist (bootstrap/emergency),
3. a protected Firestore flag (`users/{uid}.isDeveloper` or `subscriptions/{uid}.isDeveloper`).

Firestore rules block clients from writing `isDeveloper`, `developer`, and
`unlimited`; `subscriptions` is server-only. Normal user flows are unchanged:
the developer checks only run for accounts that actually have one of the flags.

## 1. Create / grant the account

The user must already exist in Firebase Auth (sign up normally first).

**Option A — env bootstrap (fastest):** set one of these in the server env and
redeploy:

```dotenv
DEVELOPER_EMAILS=you@example.com
# or
DEVELOPER_UIDS=<firebase-uid>
```

**Option B — signed claim (recommended):** with the Firebase Admin env vars
present locally:

```bash
npm run developer:grant -- --email you@example.com
# or: npm run developer:grant -- --uid <firebase-uid>
```

This writes the `developer: true` claim plus the protected Firestore flags on
`users/{uid}` and `subscriptions/{uid}`. The client must refresh its ID token
afterwards:

```ts
await firebaseAuth.currentUser?.getIdToken(true);
```

**Revoke:**

```bash
npm run developer:grant -- --email you@example.com --revoke
```

Revoking removes the claim and sets the Firestore flags to `false`. It does not
delete the account or its data.

## 2. What the developer account gets

- Effective plan is reported as `ultimate`, with `isDeveloper: true` and
  `unlimited: true`.
- All 13 personas are unlocked.
- Chat quota is never enforced and `subscriptions.messageCount` is never
  incremented for developer chat.
- `POST /api/payment-order` returns **409** `{ code: "developer_account" }`
  (no real charge is created).
- `POST /api/trial/start` returns **409** `{ code: "developer_account" }`
  (the one-time trial is not consumed).
- `DELETE /api/account` returns **403** `{ code: "developer_account" }` so the
  admin account cannot be deleted by accident from the app. Revoke developer
  status first if deletion is really intended.
- Existing real subscriptions/payments are untouched; `POST /api/payment-cancel`
  still works for billing cleanup, and developer access remains virtual.

## 3. Read-only developer API

All routes require `Authorization: Bearer <idToken>` **and** developer status.
A normal authenticated user gets **403** `{ code: "developer_only" }`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/developer/overview` | Environment, collection counts, plan catalog, provider/key status, current developer identity |
| GET | `/api/developer/users?limit=25&pageToken=` | Firebase Auth user browser (paginated) |
| GET | `/api/developer/users/:uid` | Auth record + `users/{uid}` + `subscriptions/{uid}` + latest 20 payments + effective plan |
| GET | `/api/developer/collections` | Read-only collection allowlist |
| GET | `/api/developer/collections/:name?limit=25&uid=&cursor=` | Read docs from an allowlisted collection |
| GET | `/api/developer/provider-usage` | OpenRouter key usage/limits, Groq config, Razorpay mode |
| GET | `/api/developer/logs?limit=50&level=&event=&uid=&cursor=` | Read-only app event log (appLogs), newest first |

Allowlisted collections: `users`, `subscriptions`, `payments`, `rateLimits`,
`appLogs`, plus anything listed in `CHAT_COLLECTIONS`. Firestore Timestamps
are serialized to ISO strings. Nothing in this API writes data.

`GET /api/developer/collections/:name` supports:
- `uid=<uid>` — direct doc for `users`/`subscriptions`, `where('uid','==',uid)`
  for other collections.
- `cursor=<lastDocId>` — pagination; response includes `nextCursor` when a full
  page was returned.
- `limit` — clamped to 1..100 (default 25).

### App event logs (appLogs)

Key operational events are persisted to the `appLogs` collection so the
developer screen can show them without access to the Vercel log stream:
`chat_reply` (model + timings, never message content), `chat_upstream_error`,
`chat_quota_exhausted`, `chat_client_disconnect`, `payment_order_created`,
`payment_order_failed`, `payment_verified`, `trial_started`, `account_deleted`.

- `GET /api/developer/logs` returns newest-first records
  `{ id, ts, level, event, uid, route, status, durationMs, detail }`.
- Filters: `level=info|warn|error`, `event=<name>`, `uid=<uid>` (applied in
  code — no Firestore composite indexes needed). `cursor` is the numeric `ts`
  of the last record of the previous page; `nextCursor` continues paging.
- Writes are fire-and-forget and add no latency to responses; set
  `APP_LOGS_ENABLED=false` to disable them entirely.
- Each doc carries `expiresAt` (ts + 30 days). Enable a Firestore TTL policy
  on `expiresAt` (Firebase console → Firestore → appLogs → TTL) so logs age
  out automatically.

## 4. Frontend changes required

### 4.1 Detect developer mode

Use the additive fields now returned by `GET /api/user/usage` (and
`GET /api/user/plan`):

```json
{
  "plan": "ultimate",
  "isDeveloper": true,
  "unlimited": true,
  "messagesUsed": 0,
  "messagesRemaining": 200,
  "messagesTotal": 200,
  "quotaPercent": 0,
  "showRefillTimer": false,
  "trialAvailable": false
}
```

- Treat `isDeveloper === true` as the single source of truth for developer UI.
- Do **not** infer developer status from email, plan name, or a client flag.
- If the user was just granted access, call `getIdToken(true)` before reloading
  the plan/usage so the signed claim is present. The Firestore-flag fallback
  also works, but the claim is the fast path.

### 4.2 Normal chat / paywall UI

- Hide upgrade, trial, and "buy plan" CTAs when `isDeveloper` is true.
- Hide quota counters/refill countdowns; show "Unlimited (Developer)" instead.
- Do not show the paywall or `persona_locked` upgrade prompt for developers.
- Keep the existing normal-user flow exactly as-is. The developer branch is
  additive and must not change behaviour for `isDeveloper: false`.
- Handle these responses gracefully:
  - `409 { code: "developer_account" }` from payment-order/trial → toast
    "Developer accounts already have full access" and hide the CTA.
  - `403 { code: "developer_account" }` from account deletion → explain that
    developer status must be revoked server-side first.

### 4.3 Developer/Admin screen

Add a screen (e.g. Settings → Developer) that is only rendered when
`isDeveloper === true`. Suggested sections:

1. **Overview** — `GET /api/developer/overview`
   - environment, collection counts, plan catalog, Groq/OpenRouter/Razorpay
     configured state, current uid/email.
2. **Users** — `GET /api/developer/users`
   - list uid/email/created/last sign-in/disabled; "Load more" with
     `nextPageToken`.
   - tapping a user calls `GET /api/developer/users/:uid` to show profile,
     subscription, effective plan, and recent payments.
3. **Database browser** — `GET /api/developer/collections` then
   `GET /api/developer/collections/:name`
   - collection picker, optional uid filter, paginated docs with `cursor`.
   - render arbitrary JSON read-only (Timestamps already ISO strings).
4. **API key usage** — `GET /api/developer/provider-usage`
   - OpenRouter usage/limit/remaining/free-tier/rate-limit.
   - Groq: show configured + model; usage is not exposed by Groq's API.
   - Razorpay: show configured + `live`/`test` mode only (never the key).
5. **Logs** — `GET /api/developer/logs?limit=50&level=&event=&uid=&cursor=`
   - newest-first event list; render `ts`, `level`, `event`, `uid`, `route`,
     `status`, `durationMs`, and `detail` as JSON.
   - level chips (info/warn/error) + free-text event filter; "Load more" with
     `nextCursor`.
   - never render message content — the backend never logs it.

### 4.4 Error / access handling

- `403 developer_only` → the screen should not be reachable; if it is, hide it
  and refresh the usage endpoint.
- `401` → normal sign-out / token-refresh handling.
- Never cache or persist developer endpoint responses containing user data
  beyond the current screen session.
- Never put the Firebase service-account credentials or provider API keys in the
  frontend. All privileged access goes through the authenticated API.

### 4.5 Security constraints for the frontend

- Do not add client-side Firestore reads/writes for admin data. Rules still deny
  `subscriptions`, `rateLimits`, and any unlisted collection.
- Do not add a "make me developer" button or send an `isDeveloper` field to the
  backend. Only the server grant script/env can change developer status.
- Keep the developer screen behind the same auth state as the rest of the app;
  developer status does not bypass Firebase authentication or App Check.

## 5. Operational notes

### 5.1 Premium personas not unlocking — troubleshooting checklist

Premium access comes from the effective plan, and the effective plan only
reports Ultimate when one of the three developer markers actually exists for
that uid. If personas still show as locked:

1. **Was the grant actually run?** Creating a user in the Firebase console is
   not a grant. Run:
   ```bash
   npm run developer:grant -- --email you@example.com
   ```
   and check it printed "Granted developer access". This sets the signed
   `developer: true` claim, `users/{uid}.isDeveloper`, and
   `subscriptions/{uid}.isDeveloper/unlimited`.
2. **Refresh the ID token on the client** after granting:
   `await firebaseAuth.currentUser?.getIdToken(true)` — then reload
   `GET /api/user/plan`. The server also falls back to the Firestore flags for
   un-refreshed tokens, so a stale token alone never locks a properly granted
   account.
3. **Check what the server really thinks:** `GET /api/user/usage` must return
   `plan: "ultimate"`, `isDeveloper: true`, `unlimited: true`. If it does, any
   remaining "locked" UI is a frontend issue (see §4.1 — gate persona locks on
   `isDeveloper`, not on purchase state).
4. **Same project?** The grant script writes to the Firebase project its env
   credentials point at (`FIREBASE_PROJECT_ID`). Verify the deployed backend
   uses the same project; a grant against staging will not unlock prod.
5. Even without the claim, the chat route unlocks personas via the protected
   Firestore flags — so if step 3 shows `plan: "free"` after a successful
   grant, the flags were not written (wrong project / wrong uid).

- Set the env vars on Vercel and redeploy; the allowlist is read per request.
- Prefer the signed claim for day-to-day use. The env allowlist is useful for
  the very first account or if a token refresh is impossible.
- `GET /api/developer/overview` uses Firestore count aggregations; a missing
  collection counts as `0`.
- OpenRouter usage is fetched live from `https://openrouter.ai/api/v1/key`
  (5s timeout). Failures return `ok: false` with an `error` string, not a 500.
- The developer API is read-only by design. Any future mutation (ban user,
  refund, etc.) should be a separate, explicitly audited endpoint.
