const admin = require("firebase-admin");

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey:
        process.env.FIREBASE_PRIVATE_KEY?.replace(
          /\\n/g,
          "\n"
        ),
    }),
  });
}

const db = admin.firestore();

// Tier configuration
const PLAN_LIMITS = {
  free: {
    messages: 20,
    refreshHours: 6,
  },
  pro: {
    messages: 80,
    refreshHours: 4,
  },
  ultimate: {
    messages: 200,
    refreshHours: 2,
  },
};

// Check whether user can send message
async function checkMessages(uid) {
  const userRef = db.collection("users").doc(uid);
  const sessionRef = db.collection("sessions").doc(uid);

  const [userSnap, sessionSnap] = await Promise.all([
    userRef.get(),
    sessionRef.get(),
  ]);

  const userData = userSnap.exists ? (userSnap.data() || {}) : {};
  const sessionData = sessionSnap.exists ? (sessionSnap.data() || {}) : {};

  const tier =
    PLAN_LIMITS[userData.tier] !== undefined
      ? userData.tier
      : "free";

  const plan = PLAN_LIMITS[tier];

  let messagesUsed = sessionData.messagesUsed || 0;

  // Subscription expiry check
  if (tier !== "free" && userData.expiresAt) {
    const expiry = userData.expiresAt.toDate
      ? userData.expiresAt.toDate()
      : new Date(userData.expiresAt);

    if (expiry < new Date()) {
      throw {
        status: 402,
        code: "SUBSCRIPTION_EXPIRED",
        message: "Subscription expired",
      };
    }
  }

  const now = Date.now();

  // Last reset time
  const lastReset =
    sessionData.lastResetAt?.toDate?.().getTime?.() ||
    new Date(sessionData.lastResetAt || 0).getTime();

  const refreshMs = plan.refreshHours * 60 * 60 * 1000;

  // Auto refresh if refresh time passed
  if (!lastReset || now - lastReset >= refreshMs) {
    messagesUsed = 0;

    await sessionRef.set(
      {
        messagesUsed: 0,
        lastResetAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  }

  // Limit reached
  if (messagesUsed >= plan.messages) {
    throw {
      status: 402,
      code: "MESSAGE_LIMIT_REACHED",
      message: "Message limit reached",
    };
  }

  return {
    messagesUsed,
    messageLimit: plan.messages,
    sessionRef,
  };
}

// Increment by 1 message
async function incrementMessages(sessionRef, messagesUsed) {
  await sessionRef.set(
    {
      messagesUsed: messagesUsed + 1,
      lastUsedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
}

module.exports = {
  checkMessages,
  incrementMessages,
  db,
};