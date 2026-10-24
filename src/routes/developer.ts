import { Router, Response } from 'express';
import { auth, db } from '../config/firebaseAdmin';
import { PLAN_CONFIG, getPlanOptions } from '../constants';
import { AuthenticatedRequest } from '../middleware/authMiddleware';
import { requireDeveloper } from '../middleware/developerMiddleware';
import { getPlanState } from '../services/messageService';
import {
  countCollection,
  getDeveloperCollections,
  getProviderUsage,
  isDeveloperAccount,
  isDeveloperCollection,
  listAuthUsers,
  serializeFirestoreValue,
} from '../services/developerService';

/**
 * Read-only developer/admin API. Mounted behind authMiddleware + this router's
 * requireDeveloper gate, so normal users can never reach it. Nothing here
 * mutates data: account grants happen through scripts/grant-developer.ts.
 */
export const developerRouter = Router();
developerRouter.use(requireDeveloper);

developerRouter.get('/overview', getDeveloperOverviewHandler);
developerRouter.get('/users', getDeveloperUsersHandler);
developerRouter.get('/users/:uid', getDeveloperUserHandler);
developerRouter.get('/collections', getDeveloperCollectionsHandler);
developerRouter.get('/collections/:name', getDeveloperCollectionHandler);
developerRouter.get('/provider-usage', getDeveloperProviderUsageHandler);

interface DeveloperDoc {
  id: string;
  data: () => Record<string, unknown> | undefined;
}

function parseLimit(raw: unknown, fallback = 25): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(100, Math.max(1, Math.floor(value)));
}

function parseString(raw: unknown): string | undefined {
  return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
}

function firebaseErrorCode(error: unknown): string | null {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return null;
}

export async function getDeveloperOverviewHandler(
  _req: AuthenticatedRequest,
  res: Response
): Promise<void> {
  try {
    const collections = await Promise.all(
      getDeveloperCollections().map(async name => ({
        name,
        count: await countCollection(name),
      }))
    );

    const razorpayKeyId = process.env.RAZORPAY_KEY_ID || '';

    res.json({
      ok: true,
      time: new Date().toISOString(),
      environment: process.env.VERCEL_ENV || process.env.NODE_ENV || 'development',
      collections,
      plans: PLAN_CONFIG,
      planOptions: getPlanOptions(),
      providers: {
        groq: {
          configured: Boolean(process.env.GROQ_API_KEY),
          model: process.env.GROQ_MODEL || process.env.FALLBACK_MODEL || 'openai/gpt-oss-20b',
        },
        openrouter: {
          configured: Boolean(process.env.OPENROUTER_API_KEY || process.env.PRIMARY_API_KEY),
          model:
            process.env.OPENROUTER_MODEL || process.env.PRIMARY_MODEL || 'qwen/qwen3-14b',
        },
      },
      razorpay: {
        configured: Boolean(razorpayKeyId && process.env.RAZORPAY_KEY_SECRET),
        mode: razorpayKeyId
          ? razorpayKeyId.startsWith('rzp_live_')
            ? 'live'
            : 'test'
          : null,
      },
      developer: {
        uid: _req.user!.uid,
        email: _req.user!.email || null,
      },
    });
  } catch (error) {
    console.error('[developer] Overview failed:', error);
    res.status(500).json({ error: 'Failed to build overview' });
  }
}

export async function getDeveloperUsersHandler(
  req: AuthenticatedRequest,
  res: Response
): Promise<void> {
  try {
    const limit = parseLimit(req.query.limit, 25);
    const pageToken = parseString(req.query.pageToken);
    const result = await listAuthUsers(limit, pageToken);
    res.json(result);
  } catch (error) {
    console.error('[developer] User list failed:', error);
    res.status(500).json({ error: 'Failed to list users' });
  }
}

export async function getDeveloperUserHandler(
  req: AuthenticatedRequest,
  res: Response
): Promise<void> {
  const uid = req.params.uid ?? parseString(req.query.uid);
  if (!uid) {
    res.status(400).json({ error: 'Missing uid' });
    return;
  }

  try {
    let record;
    try {
      record = await auth.getUser(uid);
    } catch (error) {
      if (firebaseErrorCode(error) === 'auth/user-not-found') {
        res.status(404).json({ error: 'User not found' });
        return;
      }
      throw error;
    }

    const [profileSnap, subscriptionSnap, paymentsSnap] = await Promise.all([
      db.collection('users').doc(uid).get(),
      db.collection('subscriptions').doc(uid).get(),
      db.collection('payments').where('uid', '==', uid).limit(20).get(),
    ]);

    const developer = await isDeveloperAccount(uid, record.email);
    const effectivePlan = await getPlanState(uid, developer);

    res.json({
      auth: {
        uid: record.uid,
        email: record.email ?? null,
        displayName: record.displayName ?? null,
        phoneNumber: record.phoneNumber ?? null,
        disabled: record.disabled,
        emailVerified: record.emailVerified,
        createdAt: record.metadata.creationTime ?? null,
        lastSignInAt: record.metadata.lastSignInTime ?? null,
        providers: (record.providerData ?? []).map(provider => provider.providerId),
      },
      isDeveloper: developer,
      profile: profileSnap.exists ? serializeFirestoreValue(profileSnap.data() ?? {}) : null,
      subscription: subscriptionSnap.exists
        ? serializeFirestoreValue(subscriptionSnap.data() ?? {})
        : null,
      effectivePlan,
      payments: paymentsSnap.docs.map(doc => ({
        id: doc.id,
        data: serializeFirestoreValue(doc.data() ?? {}),
      })),
    });
  } catch (error) {
    console.error(`[developer] User detail failed uid=${uid.slice(0, 8)}:`, error);
    res.status(500).json({ error: 'Failed to load user' });
  }
}

export async function getDeveloperCollectionsHandler(
  _req: AuthenticatedRequest,
  res: Response
): Promise<void> {
  res.json({
    collections: getDeveloperCollections().map(name => ({ name, readOnly: true })),
  });
}

export async function getDeveloperCollectionHandler(
  req: AuthenticatedRequest,
  res: Response
): Promise<void> {
  const name = req.params.name ?? parseString(req.query.name);
  if (!name || !isDeveloperCollection(name)) {
    res.status(404).json({ error: 'Collection not available' });
    return;
  }

  try {
    const limit = parseLimit(req.query.limit, 25);
    const uid = parseString(req.query.uid);
    const cursor = parseString(req.query.cursor);
    const collection = db.collection(name);

    let docs: DeveloperDoc[];
    if (uid && (name === 'users' || name === 'subscriptions')) {
      const snap = await collection.doc(uid).get();
      docs = snap.exists ? [snap] : [];
    } else {
      let query = uid ? collection.where('uid', '==', uid) : collection;
      if (cursor) {
        const cursorSnap = await collection.doc(cursor).get();
        if (!cursorSnap.exists) {
          res.status(400).json({ error: 'Invalid cursor' });
          return;
        }
        query = query.startAfter(cursorSnap);
      }
      const snap = await query.limit(limit).get();
      docs = snap.docs;
    }

    const isSingleDocLookup = Boolean(uid) && (name === 'users' || name === 'subscriptions');
    const nextCursor =
      !isSingleDocLookup && docs.length === limit ? docs[docs.length - 1]?.id ?? null : null;

    res.json({
      collection: name,
      count: docs.length,
      docs: docs.map(doc => ({
        id: doc.id,
        data: serializeFirestoreValue(doc.data() ?? {}),
      })),
      nextCursor,
    });
  } catch (error) {
    console.error(`[developer] Collection read failed (${name}):`, error);
    res.status(500).json({ error: 'Failed to read collection' });
  }
}

export async function getDeveloperProviderUsageHandler(
  _req: AuthenticatedRequest,
  res: Response
): Promise<void> {
  try {
    const usage = await getProviderUsage();
    res.json({ ok: true, time: new Date().toISOString(), ...usage });
  } catch (error) {
    console.error('[developer] Provider usage failed:', error);
    res.status(500).json({ error: 'Failed to load provider usage' });
  }
}
