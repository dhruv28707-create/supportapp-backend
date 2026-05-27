const crypto = require("crypto");
const { db } = require("./token-guard");

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res
      .status(405)
      .json({ error: "Method not allowed" });
  }

  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      uid,
    } = req.body;

    if (
      !razorpay_order_id ||
      !razorpay_payment_id ||
      !razorpay_signature ||
      !uid
    ) {
      return res.status(400).json({
        error: "Missing required fields",
      });
    }

    // Verify Razorpay signature
    const body =
      razorpay_order_id +
      "|" +
      razorpay_payment_id;

    const expectedSignature = crypto
      .createHmac(
        "sha256",
        process.env.RAZORPAY_KEY_SECRET
      )
      .update(body)
      .digest("hex");

    if (
      expectedSignature !== razorpay_signature
    ) {
      return res.status(400).json({
        error: "Invalid signature",
      });
    }

    // Get payment record
    const paymentSnap = await db
      .collection("payments")
      .doc(razorpay_order_id)
      .get();

    if (!paymentSnap.exists) {
      return res.status(404).json({
        error: "Payment record not found",
      });
    }
    const paymentData = paymentSnap.data();

    // 🔒 Check 1: UID ownership — prevent one user verifying another's payment
    if (paymentData.uid !== uid) {
      return res.status(403).json({ error: "UID mismatch" });
    }

    // 🔒 Check 2: Double verification — prevent replaying an already-paid order
    if (paymentData.status === "paid") {
      return res.status(400).json({ error: "Payment already verified" });
    }


    const { tier } = paymentSnap.data();

    // Subscription expires in 30 days
    const expiresAt = new Date();
    expiresAt.setDate(
      expiresAt.getDate() + 30
    );

    // Update user subscription
    await db
      .collection("users")
      .doc(uid)
      .set(
        {
          tier,
          premium: true,
          expiresAt,
          razorpayOrderId:
            razorpay_order_id,
        },
        { merge: true }
      );

    // Reset ONLY message usage
    await db
      .collection("sessions")
      .doc(uid)
      .set(
        {
          messagesUsed: 0,
          messageUsageDate: new Date()
            .toISOString()
            .slice(0, 10),
          updatedAt:
            new Date(),
        },
        { merge: true }
      );

    // Mark payment completed
    await db
      .collection("payments")
      .doc(razorpay_order_id)
      .set(
        {
          status: "paid",
          razorpay_payment_id,
          paidAt: new Date(),
        },
        { merge: true }
      );

    return res.json({
      success: true,
      tier,
      expiresAt,
    });
  } catch (error) {
    console.error(
      "PAYMENT VERIFY ERROR:",
      error
    );

    return res.status(500).json({
      error:
        error.message ||
        "Internal server error",
    });
  }
};