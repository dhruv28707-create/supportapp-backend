const admin = require("firebase-admin");

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
    }),
  });
}

const db = admin.firestore();

const TOKEN_LIMITS = {
  free: 10000,
  pro: 15000,
  ultimate: 30000,
  developer: Infinity,
};

const DEVELOPER_EMAILS = [
  "piyush28707@gmail.com",
  "prachibhatt1972007@gmail.com",
];

// FIX: removed developerAccess param entirely — backend decides, not frontend
async function checkToken(uid) {
  const userSnap = await db.collection("users").doc(uid).get();
  if (!userSnap.exists) throw { status: 404, message: "User not found" };

  const { tier, expiresAt, email } = userSnap.data();

  // FIX: only Firestore tier or hardcoded email grants developer status
  const isDeveloper =
    tier === "developer" ||
    (email && DEVELOPER_EMAILS.includes(email));

  if (isDeveloper) {
    const sessionRef = db.collection("sessions").doc(uid);
    return {
      tier: "developer",
      tokenLimit: Infinity,
      tokensUsed: 0,
      sessionRef,
      isDeveloper: true,
      today: new Date().toISOString().slice(0, 10),
    };
  }

  // Subscription expiry check (non-free tiers only)
  if (tier !== "free" && expiresAt) {
    const expiry = expiresAt.toDate ? expiresAt.toDate() : new Date(expiresAt);
    if (expiry < new Date()) {
      throw { status: 402, code: "SUBSCRIPTION_EXPIRED", message: "Subscription expired" };
    }
  }

  // FIX: if tier is missing/undefined in Firestore, safely fall back to "free"
  const resolvedTier = TOKEN_LIMITS[tier] !== undefined ? tier : "free";
  const tokenLimit = TOKEN_LIMITS[resolvedTier];

  const sessionRef = db.collection("sessions").doc(uid);
  const sessionSnap = await sessionRef.get();
  const sessionData = sessionSnap.exists ? sessionSnap.data() : {};
  const today = new Date().toISOString().slice(0, 10);

  // FIX: || 0 prevents stale/corrupt tokensUsed from blocking user immediately
  const tokensUsed =
    sessionData.usageDate === today ? sessionData.tokensUsed || 0 : 0;

  if (tokensUsed >= tokenLimit) {
    throw { status: 402, code: "TOKENS_EXHAUSTED", message: "Token limit reached" };
  }

  return { tier: resolvedTier, tokenLimit, tokensUsed, sessionRef, isDeveloper: false, today };
}

async function incrementTokens(sessionRef, tokensUsed, completionTokens, tokenLimit, isDeveloper = false, today) {
  if (isDeveloper || tokenLimit === Infinity) {
    await sessionRef.set(
      {
        tokensUsed: admin.firestore.FieldValue.increment(completionTokens),
        lastUsedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    return;
  }

  const newTotal = tokensUsed + completionTokens;
  // FIX: today was sometimes undefined, causing usageDate to never match
  const usageDate = today || new Date().toISOString().slice(0, 10);

  await sessionRef.set(
    {
      tokensUsed: newTotal,
      usageDate,
      lastUsedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
}

module.exports = { checkToken, incrementTokens, db };