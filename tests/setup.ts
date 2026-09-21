/**
 * Vitest setup file (loaded via setupFiles BEFORE each test module).
 * Installs module mocks for firebase-admin, the Razorpay SDK and dotenv,
 * backed by one in-memory MockFirestore, and stubs global fetch.
 *
 * Test files import the exported mocks/helpers FROM THIS MODULE — the setup
 * module is loaded once and cached, so every importer sees the same
 * instances.
 */
import { vi } from 'vitest';
import {
  MockFirestore,
  MockWriteBatch,
  FieldValue,
} from './mocks/mockFirestore';

// Shared Razorpay stubs: every `new Razorpay()` (the src singleton AND any
// instance tests construct to stub) shares the SAME vi.fn() objects, so
// `new Ctor().orders.create.mockResolvedValue(...)` in a test is visible to
// the `razorpay` singleton the routes actually call. Per-instance fns would
// make every stub invisible (the payment-order 500 regression).
const razorpayMocks = vi.hoisted(() => ({
  ordersCreate: vi.fn(),
  paymentsFetch: vi.fn(),
  subscriptionsCancel: vi.fn(),
}));

export const mockRazorpayOrdersCreate = razorpayMocks.ordersCreate;
export const mockRazorpayPaymentsFetch = razorpayMocks.paymentsFetch;
export const mockRazorpaySubscriptionsCancel = razorpayMocks.subscriptionsCancel;

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
}));

vi.mock('firebase-admin', () => {
  const fakeApp = { name: 'mock' };
  const firestoreFacade = {
    collection: (name: string) => mockDb.collection(name),
    batch: () => new MockWriteBatch(mockDb),
    // messageService no longer uses transactions, but keep a loud fallback
    // so any regression back to transactions fails tests immediately.
    runTransaction: async () => {
      throw new Error('runTransaction called — hot paths must be transaction-free');
    },
    listCollections: async () => [],
  };
  const admin = {
    apps: [fakeApp],
    app: () => fakeApp,
    initializeApp: vi.fn(() => fakeApp),
    credential: { cert: vi.fn() },
    firestore: vi.fn(() => firestoreFacade),
    auth: vi.fn(() => mockAuth),
    appCheck: vi.fn(() => mockAppCheck),
  };
  return { default: admin };
});

vi.mock('razorpay', () => {
  return {
    default: class MockRazorpay {
      orders = { create: razorpayMocks.ordersCreate };
      payments = { fetch: razorpayMocks.paymentsFetch };
      subscriptions = { cancel: razorpayMocks.subscriptionsCancel };
    },
  };
});

vi.mock('dotenv', () => ({ default: { config: vi.fn() } }));

// --- global fetch stub ---------------------------------------------------
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

// --- helpers ---------------------------------------------------------------

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
  mockRazorpayOrdersCreate.mockReset();
  mockRazorpayPaymentsFetch.mockReset();
  mockRazorpaySubscriptionsCancel.mockReset();
  vi.unstubAllEnvs();
  // Default env stubs so lazily-read keys (chat AI keys, Razorpay id) are
  // present unless a test overrides them. Must come AFTER unstubAllEnvs.
  vi.stubEnv('OPENROUTER_API_KEY', 'test-openrouter-key');
  vi.stubEnv('GROQ_API_KEY', 'test-groq-key');
  vi.stubEnv('RAZORPAY_KEY_ID', 'test_key_id');
  vi.stubEnv('RAZORPAY_KEY_SECRET', 'test_secret');
}
