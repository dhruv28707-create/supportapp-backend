import {
  Transaction,
  DocumentReference,
  DocumentData,
} from 'firebase-admin/firestore';
import { db } from '../config/firebaseAdmin';
import { PLAN_CONFIG, PlanType, DEFAULT_PLAN, LimitReachedError } from '../constants';
import { SUBSCRIPTIONS_COLLECTION, PAYMENTS_COLLECTION } from './subscriptionService';

export interface UserMessageState {
  plan: PlanType;
  messageCount: number;
  lastResetAt: number;
}

interface SubscriptionState {
  plan: PlanType;
  messageCount: number;
  lastResetAt: number;
  expiresAt: number | null;
}

function toEpochMs(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  if (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { toDate?: unknown }).toDate === 'function'
  ) {
    const date = (value as { toDate: () => Date }).toDate();
    return date instanceof Date ? date.getTime() : null;
  }
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? null : parsed;
}

function normalizeState(data: DocumentData): SubscriptionState {
  const planRaw = typeof data.plan === 'string' ? data.plan : '';
  const plan: PlanType = (PLAN_CONFIG as Record<string, unknown>)[planRaw]
    ? (planRaw as PlanType)
    : DEFAULT_PLAN;

  return {
    plan,
    messageCount: typeof data.messageCount === 'number' ? data.messageCount : 0,
    lastResetAt: typeof data.lastResetAt === 'number' ? data.lastResetAt : 0,
    expiresAt: toEpochMs(data.expiresAt),
  };
}

/**
 * Reads subscription state from the server-only `subscriptions/{uid}` doc.
 * On first read, migrates a still-valid paid plan from the legacy
 * `users/{uid}` doc so existing customers keep their plan.
 */
async function loadSubscriptionState(
  transaction: Transaction,
  uid: string
): Promise<{ state: SubscriptionState; ref: DocumentReference }> {
  const subRef = db.collection(SUBSCRIPTIONS_COLLECTION).doc(uid);
  const subSnap = await transaction.get(subRef);

  if (subSnap.exists) {
    return { state: normalizeState(subSnap.data() || {}), ref: subRef };
  }

  // Legacy migration: `users/{uid}` may be client-writable, so we only trust
  // its plan data when it is backed by a verified paid payment record.
  const userSnap = await transaction.get(db.collection('users').doc(uid));
  if (userSnap.exists) {
    const userData = userSnap.data() || {};
    const legacy = normalizeState(userData);
    const orderId = typeof userData.razorpayOrderId === 'string' ? userData.razorpayOrderId : null;
    if (
      legacy.plan !== DEFAULT_PLAN &&
      legacy.expiresAt !== null &&
      legacy.expiresAt > Date.now() &&
      orderId !== null
    ) {
      const paymentSnap = await transaction.get(db.collection(PAYMENTS_COLLECTION).doc(orderId));
      if (paymentSnap.exists && paymentSnap.data()?.status === 'paid') {
        return {
          state: { ...legacy, lastResetAt: Date.now() },
          ref: subRef,
        };
      }
    }
  }

  return {
    state: { plan: DEFAULT_PLAN, messageCount: 0, lastResetAt: Date.now(), expiresAt: null },
    ref: subRef,
  };
}

/** Applies subscription expiry: an expired paid plan is downgraded to free. */
function applyExpiry(state: SubscriptionState, now: number): SubscriptionState {
  if (
    state.plan !== DEFAULT_PLAN &&
    state.expiresAt !== null &&
    now >= state.expiresAt
  ) {
    return { ...state, plan: DEFAULT_PLAN, expiresAt: null };
  }
  return state;
}

export async function checkAndConsumeMessage(uid: string): Promise<{ success: true }> {
  return await db.runTransaction(async (transaction) => {
    const { state, ref } = await loadSubscriptionState(transaction, uid);
    const now = Date.now();

    const active = applyExpiry(state, now);
    const config = PLAN_CONFIG[active.plan];

    let messageCount = active.messageCount;
    let lastResetAt = active.lastResetAt;

    // Refresh window (message quota resets after refreshMs).
    if (now - lastResetAt >= config.refreshMs) {
      messageCount = 0;
      lastResetAt = now;
    }

    if (messageCount >= config.limit) {
      throw new LimitReachedError(lastResetAt + config.refreshMs, active.plan);
    }

    transaction.set(
      ref,
      {
        plan: active.plan,
        expiresAt: active.expiresAt,
        messageCount: messageCount + 1,
        lastResetAt,
        updatedAt: now,
      },
      { merge: true }
    );

    return { success: true };
  });
}

export async function checkAndResetOnly(uid: string): Promise<UserMessageState> {
  return await db.runTransaction(async (transaction) => {
    const { state, ref } = await loadSubscriptionState(transaction, uid);
    const now = Date.now();

    const active = applyExpiry(state, now);
    const config = PLAN_CONFIG[active.plan];

    let messageCount = active.messageCount;
    let lastResetAt = active.lastResetAt;

    if (now - lastResetAt >= config.refreshMs) {
      messageCount = 0;
      lastResetAt = now;
      transaction.set(
        ref,
        {
          plan: active.plan,
          expiresAt: active.expiresAt,
          messageCount: 0,
          lastResetAt,
          updatedAt: now,
        },
        { merge: true }
      );
    } else if (active.plan !== state.plan) {
      transaction.set(
        ref,
        { plan: active.plan, expiresAt: active.expiresAt, updatedAt: now },
        { merge: true }
      );
    }

    return { plan: active.plan, messageCount, lastResetAt };
  });
}
