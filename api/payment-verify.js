const crypto = require("crypto");
const { db } = require("./token-guard");

const TIER_LIMITS = {
  pro: 15000,
  ultimate: 30000,
};

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, uid } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature || !uid) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // ── Signature verification ───────────────────────────────────────────────
    const body = razorpay_order_id + "|" + razorpay_payment_id;
    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(body)
      .digest("hex");

    if (expectedSignature !== razorpay_signature) {
      return res.status(400).json({ error: "Invalid signature" });
    }

    // ── Get tier from payment doc ────────────────────────────────────────────
    const paymentSnap = await db.collection("payments").doc(razorpay_order_id).get();
    if (!paymentSnap.exists) return res.status(404).json({ error: "Payment record not found" });

    const { tier } = paymentSnap.data();

    // ── 30-day expiry ────────────────────────────────────────────────────────
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 30);

    // ── Update user tier + expiry ────────────────────────────────────────────
    await db.collection("users").doc(uid).set(
      { tier, expiresAt, razorpayOrderId: razorpay_order_id },
      { merge: true }
    );

    // ── Reset session tokens ─────────────────────────────────────────────────
    await db.collection("sessions").doc(uid).set(
      { tokensUsed: 0, tokenLimit: TIER_LIMITS[tier] || 15000 },
      { merge: true }
    );

    // ── Mark payment as paid ─────────────────────────────────────────────────
    await db.collection("payments").doc(razorpay_order_id).set(
      { status: "paid", razorpay_payment_id, paidAt: new Date() },
      { merge: true }
    );

    res.json({ success: true, tier, expiresAt });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};