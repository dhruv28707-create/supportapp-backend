const fetch = require("node-fetch");
const { checkToken, incrementTokens } = require("./token-guard");

const GROQ_API_KEY = process.env.GROQ_API_KEY;

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    // FIX: removed developerAccess from destructuring — we never use it anymore
    const { messages, uid } = req.body;

    if (!uid) return res.status(400).json({ error: "uid is required" });

    // FIX: checkToken now takes only uid — no developerAccess param
    const { tokenLimit, tokensUsed, sessionRef, isDeveloper, today } =
      await checkToken(uid);

    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages: messages,
        max_tokens: 200,
      }),
    });

    const data = await response.json();

    // FIX: now correctly passes isDeveloper and today so date reset works properly
    const completionTokens = data?.usage?.completion_tokens || 0;
    await incrementTokens(sessionRef, tokensUsed, completionTokens, tokenLimit, isDeveloper, today);

    res.json(data);
  } catch (error) {
    if (error.status) {
      return res.status(error.status).json({ error: error.message, code: error.code });
    }
    res.status(500).json({ error: error.message });
  }
};