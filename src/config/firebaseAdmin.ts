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

// NOTE: `DEP0169: url.parse() is deprecated` in prod logs comes from inside
// firebase-admin v12 itself, not our code. Silenced via
// NODE_OPTIONS=--no-deprecation (vercel.json).

// Cold-start warmup: one cheap read at import overlaps the Firestore
// handshake with boot instead of stacking it onto the first request.
// Skipped under tests (in-memory mock there).
if (process.env.NODE_ENV !== 'test') {
  void db
    .collection('__health')
    .doc('check')
    .get()
    .catch(() => {
      // Best effort only — real call sites surface their own errors.
    });
}