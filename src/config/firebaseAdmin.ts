import admin from 'firebase-admin';

function initializeFirebaseAdmin(): admin.app.App {
  if (admin.apps.length > 0) {
    return admin.apps[0]!;
  }

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');

  if (!projectId || !clientEmail || !privateKey) {
    throw new Error('Missing Firebase Admin SDK environment variables');
  }

  return admin.initializeApp({
    credential: admin.credential.cert({
      projectId,
      clientEmail,
      privateKey,
    }),
  });
}

const app = initializeFirebaseAdmin();

export const db = admin.firestore(app);
export const auth = admin.auth(app);
export const appCheck = admin.appCheck(app);

// ---------------------------------------------------------------------------
// NOTE on `DEP0169: url.parse() is deprecated` in prod logs:
// It is emitted from INSIDE firebase-admin v12 itself
// (lib/utils/api-request.js, lib/utils/validator.js) — `grep url.parse`
// under src/ returns nothing, so there is no call site of ours to rewrite.
// Harmless SDK noise, printed once per cold start; silenced via
// NODE_OPTIONS=--no-deprecation (vercel.json). The durable fix is a major
// SDK upgrade (fixed upstream, but v14 needs Node >= 22 while package.json
// targets >= 18), so that waits for a deliberate upgrade + QA pass.
// ---------------------------------------------------------------------------

// Cold-start warmup: the first Firestore op on a fresh serverless instance
// pays the gRPC/TLS handshake — prod timings showed plan=2293ms on cold
// reads while the AI itself took 432ms. One cheap read at import overlaps
// the handshake with boot instead of stacking it onto the first user's
// message. Skipped under tests (backed by the in-memory mock there).
if (process.env.NODE_ENV !== 'test') {
  void db
    .collection('__health')
    .doc('check')
    .get()
    .catch(() => {
      // Best effort only — real call sites surface their own errors.
    });
}