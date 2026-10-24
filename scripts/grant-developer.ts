import 'dotenv/config';
import { auth, db } from '../src/config/firebaseAdmin';

/**
 * Grants or revokes developer access for an existing Firebase Auth account.
 *
 * Usage:
 *   npm run developer:grant -- --email dev@example.com
 *   npm run developer:grant -- --uid <firebase-uid>
 *   npm run developer:grant -- --email dev@example.com --revoke
 *
 * This is the only supported way to create a developer account. It writes:
 *   - the signed `developer: true` custom claim (the fast path for chat/quota)
 *   - users/{uid}.isDeveloper (protected by Firestore rules)
 *   - subscriptions/{uid}.isDeveloper (server-only; covers an existing sub)
 *
 * The account must sign in again / call getIdToken(true) before the claim is
 * visible to the client and to already-issued tokens.
 */
function getArg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  return value && !value.startsWith('--') ? value : undefined;
}

async function main(): Promise<void> {
  const revoke = process.argv.includes('--revoke');
  const email = getArg('--email') || process.env.DEVELOPER_EMAIL;
  const uid = getArg('--uid') || process.env.DEVELOPER_UID;

  if (!email && !uid) {
    throw new Error('Provide --email <address> or --uid <firebase-uid>');
  }

  const user = uid ? await auth.getUser(uid) : await auth.getUserByEmail(email!);
  const claims: Record<string, unknown> = { ...(user.customClaims ?? {}) };

  if (revoke) {
    delete claims.developer;
  } else {
    claims.developer = true;
  }

  await auth.setCustomUserClaims(user.uid, claims);

  const flag = !revoke;
  const now = Date.now();

  await db.collection('users').doc(user.uid).set(
    { isDeveloper: flag, developer: flag, updatedAt: now },
    { merge: true }
  );

  // `subscriptions` is server-only; writing here also covers accounts that
  // already have a real subscription doc. The existing plan is preserved.
  await db.collection('subscriptions').doc(user.uid).set(
    { isDeveloper: flag, developer: flag, unlimited: flag, updatedAt: now },
    { merge: true }
  );

  console.log(
    `${revoke ? 'Revoked' : 'Granted'} developer access for ${user.email || user.uid} (${user.uid}).`
  );
  if (!revoke) {
    console.log('Next: the client must refresh its ID token (getIdToken(true)).');
  }
}

main().catch(error => {
  console.error('Developer grant failed:', error);
  process.exitCode = 1;
});
