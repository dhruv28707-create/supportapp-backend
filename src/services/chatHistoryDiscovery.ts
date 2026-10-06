/**
 * Chat-history discovery for the account-deletion purge. Chat context lives
 * client-side, so history in Firestore is app-written in an unknown shape —
 * the purge walks well-known shapes plus CHAT_COLLECTIONS overrides. Only
 * ids/field names are surfaced, never message content.
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
  // Throw on failure so the caller counts it (residual data stays visible).
  const snap = await db.collection('users').doc(uid).listCollections();
  return snap.map((c) => c.id);
}
