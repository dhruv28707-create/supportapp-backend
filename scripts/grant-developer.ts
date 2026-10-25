import 'dotenv/config';
import type { UserRecord } from 'firebase-admin/auth';
import readline from 'readline';
import { auth, db } from '../src/config/firebaseAdmin';

/**
 * Grants or revokes developer access for an existing Firebase Auth account.
 *
 * Usage:
 *   npm run developer:grant -- --email dev@example.com
 *   npm run developer:grant -- --uid <firebase-uid>
 *   npm run developer:grant -- --email dev@example.com --revoke
 *   npm run developer:grant -- --email dev@example.com --create
 *
 * --create first creates the Auth user when it does not exist yet. The
 * password is prompted for (hidden input) or taken from DEVELOPER_PASSWORD
 * when non-interactive. This is the only supported way to create a developer
 * account. It writes:
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

/** Hidden prompt that only works when stdin is a TTY. */
function readHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      resolve('');
      return;
    }

    process.stdout.write(question);
    const rl = readline.createInterface({ input: stdin, output: process.stdout, terminal: true });
    const muted = rl as unknown as { stdoutMuted?: boolean; _writeToOutput?: (output: string) => void };
    muted.stdoutMuted = true;
    muted._writeToOutput = function (output: string): void {
      if (muted.stdoutMuted) {
        if (!output.includes('\r') && !output.includes('\n')) process.stdout.write('*');
      } else {
        process.stdout.write(output);
      }
    };

    rl.question('', (answer) => {
      muted.stdoutMuted = false;
      process.stdout.write('\n');
      rl.close();
      resolve(answer);
    });
  });
}

async function main(): Promise<void> {
  const revoke = process.argv.includes('--revoke');
  const create = process.argv.includes('--create');
  const email = getArg('--email') || process.env.DEVELOPER_EMAIL;
  const uid = getArg('--uid') || process.env.DEVELOPER_UID;

  if (!email && !uid) {
    throw new Error('Provide --email <address> or --uid <firebase-uid>');
  }
  if (create && uid) {
    throw new Error('--create only works with --email (a password-backed account is needed).');
  }

  let user: UserRecord | undefined;
  try {
    user = uid ? await auth.getUser(uid) : await auth.getUserByEmail(email!);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (create && (code === 'auth/user-not-found' || code === 'auth/argument-error')) {
      let password = process.env.DEVELOPER_PASSWORD || '';
      if (!password) {
        password = await readHidden(`Password for ${email} (input hidden): `);
      }
      if (!password || password.length < 6) {
        throw new Error('Firebase requires a password of at least 6 characters.');
      }
      user = await auth.createUser({ email: email!, password, displayName: 'Developer' });
      console.log(`Created Firebase Auth user ${user.email} (${user.uid}).`);
    } else {
      throw error;
    }
  }
  if (!user) {
    throw new Error(
      `No Firebase Auth user for ${email || uid}. Sign up with that email first (a password is set there), ` +
        'or rerun with --create to create it:\n  npm run developer:grant -- --email <address> --create'
    );
  }
  const claims: Record<string, unknown> = { ...(user.customClaims ?? {}) };

  if (revoke) {
    delete claims.developer;
  } else {
    claims.developer = true;
  }

  if (!revoke && !user.emailVerified) {
    await auth.updateUser(user.uid, { emailVerified: true });
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
