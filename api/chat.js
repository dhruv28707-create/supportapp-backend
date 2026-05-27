const fetch = require("node-fetch");
const {
  checkMessages,
  incrementMessages,
} = require("./token-guard");

const GROQ_API_KEY = process.env.GROQ_API_KEY;

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
    const { messages, uid } = req.body;

    if (!uid) {
      return res
        .status(400)
        .json({ error: "uid is required" });
    }

    // Message-based limit check
    const {
      messagesUsed,
      dailyLimit,
      sessionRef,
      today,
    } = await checkMessages(uid);

    const response = await fetch(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${GROQ_API_KEY}`,
        },
        body: JSON.stringify({
          model: "llama-3.3-70b-versatile",
          messages,
          max_tokens: 200,
        }),
      }
    );

    const data = await response.json();
    if (!response.ok) {
      console.error("GROQ API ERROR:", response.status, JSON.stringify(data));
      return res.status(response.status).json({
      error: data?.error?.message || "GROQ API error",
      groqStatus: response.status,
      });
    }

    // Increment only by 1 message
    await incrementMessages(
      sessionRef,
      messagesUsed,
      today
    );

    return res.json({
      ...data,

      usage: {
        messagesUsed: messagesUsed + 1,
        dailyLimit,
        remainingMessages:
          dailyLimit - (messagesUsed + 1),
      },
    });
  } catch (error) {
    console.error("CHAT ERROR:", error);

    if (error.status) {
      return res.status(error.status).json({
        error: error.message,
        code: error.code,
      });
    }

    return res.status(500).json({
      error: error.message || "Internal server error",
    });
  }
};