# SAFESPACE Backend — Security Audit Report & Remediation Log

**Date:** 2026-10-31
**Scope:** Full external-facing surface of `supportapp-backend` (chat, quota/billing, trials, payments, account lifecycle, developer API, log-drain receiver, IP throttles)
**Verification:** `npm test` (123 tests passing), `npm run typecheck`, `npm run lint`, `npm run build` — all green.

---

## 1. Findings at a glance

| # | Finding | Severity | Status |
|---|---------|----------|--------|
| 1 | Fresh-document abuse path (trial/churn + abusers riding pacing) — stacking attack | High | Fixed (push `52d8319` + `6d96be2`) |
| 2 | Quota: pre-AI gate + non-atomic post-reply consume → concurrent burst bypasses the plan cap (TOCTOU) | High | Fixed (push `6d96be2`, hardened further this session) |
| 3 | Compression-bomb DoS in the Vercel log-drain (`gunzipSync`, unbounded output) | High | Fixed (push `6d96be2`) |
| 4 | `auth.getUser()` on every plan/usage read, no rate limit → Identity Toolkit quota burn (fail-open) | Medium | Fixed (push `6d96be2`) |
| 5 | Client-supplied history as a prompt-injection jailbreak vector (16 × 2000-char budget) | Medium | Fixed (this session) |
| 6 | `x-vercel-forwarded-for` trusted blindly → attacker picks the per-IP throttle key | High | Fixed (this session) |
| 7 | Secret reuse: `IP_HASH_SECRET` fell back to `RAZORPAY_WEBHOOK_SECRET` | Medium | Fixed (this session) |
| 8 | Per-instance circuit breakers never shared across serverless instances | Low (cost/latency) | Fixed (this session) |

All eight findings are closed and each fix has regression tests that fail if the hole re-opens.

---

## 2. Push history (last two pushes)

### Push 1 — `52d8319` "Fixed the critical issue" (2026-10-31 15:47 IST)

**Attack it closed (finding #1 class):** the trial/churn was farmable and the abuse defenses had gaps — one script could farm the 5-day Ultimate trial by cycling *trial → cancel → delete account → re-signup with the same email*, getting fresh uid + fresh `creationTime` each time (fresh trial eligibility + unbounded free quota resets), because the once-ever-trial state lived only in documents that deletion wiped.

**Changes (11 files, +308/−41):**
- **Durable anti-churn ledger** — `subscriptionService.ts`: new server-only `trialGuards/{key}` collection; docs keyed by uid (`uid_<uid>`) AND by hashed email (`email_<sha256(email)>`). The trial grant is transactional against the ledger, so the one-time trial survives account deletion + same-email re-signup. Legacy gaps (accounts whose `trialUsed` predates the ledger) are back-filled on any refused attempt.
- **Firestore rules** (`firestore.rules`): `trialGuards/{docId}` is `allow read, write: if false` — fully server-only, client can never read or forge it.
- **`messageService.ts`** — quota state now reads from server-only `subscriptions/{uid}`, never trusting the client-writable `users/{uid}` doc for plan data; legacy paid plan only honored when backed by a server-verified **paid** payment record.
- **Deployment surface cleanup** — stray serverless adapter (`api/[[...route]].ts`) and vercel.json function routes removed (single Node server / express app is the runtime); package scripts trimmed.
- **`trialStart.ts` / `accountDeletionService.ts`** — wired to the shared guard logic and durable-ledger semantics.
- **Tests:** trial grant/refusal matrix, churn-cycle attack (delete + same-email re-signup blocked), cancel-treatment of `trialUsed`, quota-state trust boundaries.

### Push 2 — `6d96be2` "Fixed the higher issues" (2026-10-31 16:04 IST)

**Attacks it closed (findings #2, #3, #4):**

**#2 — quota TOCTOU (burst bypass).** The pre-AI gate (`chatSend.ts`) is only a fast-fail hint; the consume ran after the AI reply as read → check → increment(1) with no atomicity. Firing N concurrent chats with the window near reset made every in-flight request pass the gate and consume — 20/5h free quota became effectively unbounded under a burst; same for pro/ultimate. An interim "atomic band" (10) patch did NOT fully close it: a burst starting far below the cap all read the same stale count.
- **Fix:** `consumeMessage` is now **always transactional** (`messageService.ts`): plan state, developer flag, expiry and the count are re-derived *inside* the transaction (shared `resolveSubscriptionState` rules), and the write commits only when `count < plan limit` on that in-transaction read. Firestore's per-document serialization makes the cap a hard cap — a burst of any size cannot push `messageCount` past the limit; surplus requests get `LimitReachedError` (accounting only; the reply is already delivered). The pre-AI 429 gate remains as UX fast-fail only.

**#3 — compression-bomb DoS (log drain).** `vercelLogDrain.ts` HMAC-verified raw bytes (`MAX_RAW_BODY_BYTES` = 2MB), then `zlib.gunzipSync(raw)` — a signed 2MB gzip body can expand to gigabytes of memory synchronously; serverless OOM, repeatable while Vercel retries delivery. SHA-1 HMAC is Vercel's spec (kept).
- **Fix:** streamed `zlib.createGunzip()` with a byte counter that **destroys the stream mid-fill** at a 10 MB decompressed cap → 413; corrupt gzip → 400; unknown encodings → 415. Also: `express.raw` was silently inflating gzip at parse time (breaking the HMAC-over-wire-bytes contract), so the drain route now uses a dedicated **raw wire-body collector** (`app.ts`) — the HMAC is verified over the exact bytes Vercel signed, and the only decompression in the chain is the size-capped one.

**#4 — Identity Toolkit quota burn.** `userPlan.ts` / `usage.ts` called `auth.getUser()` per request for the trial-CTA hint on free users, with no limiter; hammering `/api/user/plan` with a single valid token burned project-level Identity Toolkit quota (breaking trials, deletions, developer tools), and fail-open logging kept it that way.
- **Fix:** new `trialEligibilityService.ts` — the immutable `creationTime` is cached after first sighting in the **server-only** `subscriptions/{uid}` doc (never the client-writable `users/{uid}` doc, so account age can't be forged), with per-instance in-flight dedupe: a concurrent burst issues at most one Auth call. Trial-start itself keeps its authoritative `auth.getUser()` check (rate-limited 5/10min + IP throttle).

**Also in push 2:** `firestore.rules`-compatible server-only cache semantics, mock- Firestore transaction serialization for burst-faithful tests, and new regression tests: transactional hard-cap under a 40-request concurrent burst from count 0 (exactly 20 commit, 20 refused), gzip delivery acceptance, 64MB bomb → 413, corrupt gzip → 400, creationTime caching (hammering zero Auth calls; 10-way burst → exactly 1 Auth call).

---

## 3. This session — findings #5, #6, #7, #8

### #5 — Client-supplied history as a jailbreak vector (`chatSend.ts`)

The system prompt is fixed, but the chat endpoint accepted up to 16 recent turns × **2000 chars** each (≈12,000 chars of attacker-authored "conversation") ahead of the model — enough budget to pre-agree facts, flip the persona, fake policy context, or erode the app's never-say-it's-an-AI design. Roles were allowlisted and messages length-capped, but against a fixed ~300-token reply budget, the context asymmetry was huge.

**Fix (tightened budget, defense-in-depth kept):**
```
MAX_HISTORY_MESSAGE_CHARS = 500   (was: MAX_MESSAGE_LENGTH = 2000)
MAX_HISTORY_CHARACTERS    = 4000  (was: MAX_CONTEXT_CHARACTERS = 12000)
MAX_CONTEXT_MESSAGES      = 16    (unchanged)
```
- History turns are dropped (not 400'd) when over the per-entry cap, and the working set is built oldest-first until the total budget fills — all with the existing role allowlist and the ≤50-entry scan bound.
- The **live user message keeps its full 2000-char allowance** (it's the user's actual prompt, in their own voice, after the system prompt — not pre-roll before it).
- Existing model-control-token scrubbing (`MODEL_STOP_MARKERS`, streaming-safe splitter) and the `religionSubType` allowlist remain active on top.

### #6 — `x-vercel-forwarded-for` trusted blindly → throttle-key forgery (`utils/request.ts`)

The per-IP defenses against multi-account farming key on `extractClientIp`. The old code took the **first** comma-separated value of `x-vercel-forwarded-for` whenever `VERCEL=1` — correct only if the edge overwrites the header; if it ever appends, the attacker picks the throttle key and every per-IP backstop is neutered. Un-verifiable from code alone.

**Fix (fail-safe, not fail-open):**
- On Vercel, the **direct peer address wins** (`req.ip`, which Vercel derives from the connection). The header is used only when the runtime gives no peer address at all (availability fallback, not a key-control path).
- IPv4-mapped IPv6 (`::ffff:203.0.113.7`) is normalized to plain IPv4 so socket-config differences can't split one client into multiple throttle buckets.
- `x-forwarded-for` remains opt-in only (`TRUST_FORWARDED_HEADERS=true`, local dev behind a proxy).
- Added `IP_FORWARDFOR_DEBUG=true`: logs `peer` vs `x-vercel-forwarded-for` per request so overwrite semantics can be confirmed cheaply on a test deployment and the header path retired with evidence.
- (Contextual: the earlier pacing abuse from finding #1 — unlimited fresh accounts until the abuse limiter trips — is bounded by these per-IP caps, so key integrity here matters and is now guaranteed peer-derived.)

### #7 — Secret reuse: IP hashing fell back to `RAZORPAY_WEBHOOK_SECRET` (`chatClientThrottle.ts`)

One payment secret doubling as throttle-key material: rotating a payment secret silently reshaped (or, when emptied, collapsed every IP into one dev-default bucket, disabling per-IP defense without any log in production).

**Fix:**
- `hashIp()` now uses **only** the dedicated `IP_HASH_SECRET` (HMAC-SHA256; a plain hash would be reversible by IPv4 enumeration).
- **Required in production:** missing `IP_HASH_SECRET` throws at module load (deploy fails loudly, function start aborts) instead of silently degrading to a shared bucket. Non-production keeps a dev-only default so tests/local runs work.
- `.env` annotations updated; never commit `.env`.

### #8 — Per-instance circuit breakers (`chatSend.ts`)

In-memory breakers meant each of N cold serverless instances independently burned a full 9s upstream timeout against a dead provider (and double-billed fallback tokens during provider outages) before discovering the outage.

**Fix (shared cooldown, zero hot-path cost):**
- On open, the `openedAt` timestamp is **persisted best-effort** to `rateLimits/breaker:<provider>` (one write per open event).
- Every instance TTL-caches a sync read (≤ 1 read / 10s / model, **zero Firestore reads while no breaker is open**) and only moves its local cooldown **earlier** — monotonic `openedAt`, so a stale or failed write can never re-close an open breaker locally, and cooldown expiry still probes half-open per instance.
- `BREAKER_THRESHOLD = 5` retained (converging across instances means the fleet trips faster in wall-clock terms anyway).

---

## 4. Verification

- `npm test` — 13 files / 123 tests pass, including the new regression suites:
  - hard cap under concurrent burst (40 parallel consumes from count 0 → exactly 20 commit, 20 × `LimitReachedError`);
  - gzip drain delivery, 64MB bomb → 413, corrupt gzip → 400, bogus encoding → 415;
  - creationTime cache (zero Auth calls after first lookup; 10-way burst → 1 call; unresolved account → not eligible);
  - peer-vs-header IP extraction on Vercel, IPv4-mapped normalization, header-fallback only when peer is unknown.
- `npm run typecheck`, `npm run lint`, `npm run build` — clean.
- Mock Firestore now serializes transactions end-to-end so burst tests express Firestore's commit semantics honestly.

## 5. Deployment notes

- **Set `IP_HASH_SECRET`** (dedicated random secret) in every production environment before deploying — startup will refuse without it. Never reuse `RAZORPAY_WEBHOOK_SECRET` for anything else.
- Rotation of `IP_HASH_SECRET` reshapes throttle keys (fresh windows for all IPs) — expected; rotate only deliberately.
- Optional probes/rollback levers: `IP_FORWARDFOR_DEBUG=true` (verify edge forwarding semantics), `RATE_LIMIT_FAIL_CLOSED=true` (deny on limiter storage errors if AI spend must be capped during a Firestore outage).
- `VERCEL_LOG_DRAIN_SECRET` unchanged (HMAC-SHA1 is Vercel's spec); the drain payload cap is 2MB wire / 10MB decompressed.
- Firestore security rules must keep `subscriptions`, `payments`, `trialGuards` (and now the cached `authCreatedAt` field inside `subscriptions/{uid}`) server-only.

## 6. Residual risks / recommendations (non-blocking)

- History budget is tight, not semantic: repeated 500-char turns still carry some injection surface. If this ever needs to go lower, the next lever is server-side user-history persistence (the client doesn't send history at all); post-generation screening of policy-critical lines is the alternative.
- Rate limiter payloads remain best-effort non-atomic by design (abuse backstop; plan quota is the hard wall). Fine as long as `consumeMessage` stays transactional — guarded by tests.
- The compression cap (10MB decompressed) is intentionally generous vs. any real Vercel batch (~1–2MB); tightens to taste via one constant.
