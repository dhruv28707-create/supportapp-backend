const Razorpay = require("razorpay");
const { db } = require("./token-guard");

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

const TIER_PRICES = {
  pro_monthly: 100, // ₹179 in paise
  pro_yearly: 100, // ₹699 in paise
  ultimate_monthly: 100, // ₹199 in paise
  ultimate_yearly: 100, // ₹799 in paise
};

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")
    return res.status(405).json({ error: "Method not allowed" });

  try {
    const { uid, tier, currency = "INR" } = req.body;

    if (!uid || !tier)
      return res.status(400).json({ error: "uid and tier are required" });
    if (!TIER_PRICES[tier])
      return res.status(400).json({ error: "Invalid tier" });

    const order = await razorpay.orders.create({
      amount: TIER_PRICES[tier],
      currency,
      receipt: `r_${Date.now()}`,
    });

    await db.collection("payments").doc(order.id).set({
      uid,
      tier,
      amount: order.amount,
      currency,
      status: "pending",
      createdAt: new Date(),
    });

    res.json({ orderId: order.id, amount: order.amount, currency });
  } catch (error) {
    console.error(
      "PAYMENT ORDER ERROR:",
      JSON.stringify({
        message: error.message,
        description: error?.error?.description,
        code: error?.error?.code,
        status: error?.statusCode,
      }),
    );
    res.status(500).json({ error: error.message });
  }
};
