/**
 * READ-ONLY Firestore schema inspector.
 *
 * Lists every collection id, doc id and DATA FIELD NAME for the project, so
 * the chat-history purge (deleteChatHistory in accountDeletionService.ts) can
 * be tailored to the app's real layout. Never prints field VALUES or message
 * content — names, ids and counts only.
 *
 * Usage:
 *   npx ts-node scripts/inspect-firestore.ts
 *
 * Needs the Firebase Admin env vars (FIREBASE_PROJECT_ID,
 * FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY) — e.g. `npx vercel env pull
 * .env.inspect` first, then `npx dotenv -e .env.inspect -- npx ts-node
 * scripts/inspect-firestore.ts`.
 */

// Load .env if present (same pattern as src/index.ts) — must precede imports
// that read env at module load (config/firebaseAdmin).
import 'dotenv/config';

import admin from 'firebase-admin';

function initializeFirebaseAdmin(): admin.app.App {
  if (admin.apps.length > 0) return admin.apps[0]!;

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');

  if (!projectId || !clientEmail || !privateKey) {
    console.error(
      'Missing Firebase Admin env vars. Run: npx vercel env pull .env.inspect --environment=production\n' +
        'then: npx dotenv -e .env.inspect -- npx ts-node scripts/inspect-firestore.ts'
    );
    process.exit(1);
  }

  return admin.initializeApp({
    credential: admin.credential.cert({ projectId, clientEmail, privateKey }),
  });
}

const app = initializeFirebaseAdmin();
const db = admin.firestore(app);

async function inspectCollection(collRef: FirebaseFirestore.CollectionReference, depth: number): Promise<void> {
  const indent = '  '.repeat(depth);
  const snap = await collRef.limit(3).get();
  console.log(`${indent}collection: ${collRef.id} (showing up to 3 docs)`);

  for (const doc of snap.docs) {
    const data = doc.data() || {};
    console.log(`${indent}  doc: ${doc.id}  fields: [${Object.keys(data).join(', ')}]`);

    if (depth < 2) {
      const subcollections = await doc.ref.listCollections();
      for (const sub of subcollections) {
        await inspectCollection(sub, depth + 1);
      }
    }
  }
}

async function main(): Promise<void> {
  console.log(`Firestore schema inspection for project: ${process.env.FIREBASE_PROJECT_ID}`);
  console.log('(field names and doc ids only — no values are printed)\n');

  const collections = await db.listCollections();
  if (collections.length === 0) {
    console.log('No top-level collections found.');
    return;
  }

  for (const coll of collections) {
    await inspectCollection(coll, 0);
  }

  console.log('\nDone.');
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Inspection failed:', error);
    process.exit(1);
  });
