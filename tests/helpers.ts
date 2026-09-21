/**
 * Shared test bootstrap: installs vitest module mocks for firebase-admin,
 * the Razorpay SDK and dotenv, backed by a single MockFirestore instance.
 * Import with `import { setupTestEnv } from '../helpers';` BEFORE importing
 * anything from src/.
 */
import { vi } from 'vitest';
import { MockFirestore, FieldValue } from './mocks/mockFirestore';

export const mockDb = new MockFirestore();

export const mockAuth = {
  verifyIdToken: vi.fn(),
  revokeRefreshTokens: vi.fn(),
  deleteUser: vi.fn(),
};

export const mockAppCheck = {
  verifyToken: vi.fn(),
};

vi.mock('firebase-admin/firestore', () => ({
  FieldValue,
  Timestamp: { now: () => ({ toDate: () => new Date() }) },
}));

vi.mock('firebase-admin', () => {
  const fakeApp = { name: 'mock' };
  const admin = {
    apps: [fakeApp],
    app: () => fakeApp,
    initializeApp: vi.fn(() => fakeApp),
    credential: { cert: vi.fn() },
    firestore: vi.fn(() => mockFirestoreFacade),
    auth: vi.fn(() => mockAuth),
    appCheck: vi.fn(() => mockAppCheck),
  };
  const mockFirestoreFacade = {
    collection: (name: string) => mockDb.collection(name),
    batch: () => new (require('./mocks/mockFirestore').MockWriteBatch)(mockDb),
    runTransaction: async (fn: (t: unknown) => unknown) =>
      fn({
        get: async (ref: { get: () => Promise<unknown> }) => ref.get(),
        set: () => {
          throw new Error('transactions not supported in tests');
        },
      }),
    listCollections: async () => [],
  };
  return { default: admin };
});

vi.mock('razorpay', () => ({
  default: class MockRazorpay {
    orders = { create: vi.fn() };
    payments = { fetch: vi.fn() };
    subscriptions = { cancel: vi.fn() };
  },
}));

vi.mock('dotenv', () => ({ default: { config: vi.fn() } }));

// --- global fetch stub -------------------------------------------------
export const mockFetch = vi.fn();

export function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

vi.stubGlobal('fetch', mockFetch);

// --- helpers ------------------------------------------------------------

export const VALID_TOKEN = 'valid-id-token';

/** Default successful token verification for uid `u1`. */
export function primeAuth(uid = 'u1', email = 'u1@test.dev'): void {
  mockAuth.verifyIdToken.mockResolvedValue({ uid, email });
}

export function authHeader(): Record<string, string> {
  return { Authorization: `Bearer ${VALID_TOKEN}` };
}

export function resetAll(): void {
  mockDb.reset();
  mockFetch.mockReset();
  mockAuth.verifyIdToken.mockReset();
  mockAuth.revokeRefreshTokens.mockReset();
  mockAuth.deleteUser.mockReset();
  mockAppCheck.verifyToken.mockReset();
  vi.unstubAllEnvs();
}
