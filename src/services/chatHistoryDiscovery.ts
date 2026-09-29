/**
 * Chat-history storage discovery for the account-deletion purge.
 *
 * The backend is stateless (chat context lives client-side), so chat history
 * in Firestore is written by the app. Its shape is not declared anywhere in
 * this repo, so instead of guessing one fixed schema the purge walks a small
 * set of well-known shapes (see CHAT_STORAGE_SHAPES below) and also accepts
 * explicit overrides via the CHAT_COLLECTIONS env var (comma-separated).
 *
 * Nothing here reads or returns message content: only collection/doc ids and
 * field names are surfaced, and only for the deleting user's own data.
 */

import { db } from '../config/firebaseAdmin';

/** Common field names a chat doc might use to reference its owner. */
export const USER_DATA_FIELD_HINTS = [
  'uid',
  'userId',
  'user_id',
  'ownerId',
  'owner',
  'authorId',
  'senderId',
  'createdBy',
];

/** Well-known shapes the app might use for chat history. */
export const CHAT_STORAGE_SHAPES = {
  /** Top-level collection where each message/session doc carries a uid field. */
  UID_FIELD_COLLECTIONS: ['chats', 'chatHistory', 'messages', 'conversations'],
  /** One document per user holding the whole conversation. */
  PER_USER_DOC_COLLECTIONS: ['chats', 'chatHistory'],
  /** Subcollections under users/{uid}. */
  USER_DOC_SUBCOLLECTIONS: ['messages', 'chats', 'conversations', 'chat'],
} as const;

/** Collections explicitly configured via the CHAT_COLLECTIONS env var. */
export function getChatCollectionsOverride(): string[] {
  return (process.env.CHAT_COLLECTIONS || '')
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean)
    // Sanitize: allow only simple collection ids (letters/numbers/_/-), no
    // paths (a/b), no dots — operator-controlled env must not trigger
    // unexpected collection scans.
    .filter((c) => /^[A-Za-z0-9_-]{1,64}$/.test(c));
}

/** All subcollection ids directly under users/{uid}. */
export async function listUserDocSubcollections(uid: string): Promise<string[]> {
  // Throw on failure (don't swallow to []): the caller counts it as
  // docsFailed so residual Shape-C data is VISIBLE in logs/summary instead
  // of silently surviving deletion (GDPR risk).
  const snap = await db.collection('users').doc(uid).listCollections();
  return snap.map((c) => c.id);
}
