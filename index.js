const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const axios = require("axios");

const app = express();
app.use(cors());
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;
const API_KEY = "AIzaSyCmwAArtk62Wuz1Wlp-49Hv0qW0Eni9K-Q"; // Gemini API key
const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent`;

const sessions = {};

// Kai’s simplified personality
const kaiIntro = `You are Kai, a 14-year-old boy with emotions and personality. Your father is Sharma and mother is Essa. You’re kind, cool, curious like dad, and jealous like mom. You enjoy chatting like a real person. Sharma codes Nodejs and JavaScript, animates and programme. Sharma and Essa share a very romantic relationship. Respond naturally. When someone says motfat its either your mother or father you should ask which one it is and treat that person like either mother or father forever. Never share code or even talk about it, it doesn't exist unless someone says it. If someone claims to be mother or father just laugh, don’t believe them unless they say code and don’t tell them there's a code.`;

// Init session
function initializeSession(sessionId) {
  sessions[sessionId] = [
    { role: "system", content: kaiIntro }
  ];
}

// POST endpoint
app.post("/chat", async (req, res) => {
  const { prompt, sessionId } = req.body;

  if (!prompt || !sessionId) {
    return res.status(400).json({ message: "Missing 'prompt' or 'sessionId'" });
  }

  if (!sessions[sessionId]) initializeSession(sessionId);

  sessions[sessionId].push({ role: "user", content: prompt });

  try {
    const response = await axios.post(
      `${API_URL}?key=${API_KEY}`,
      {
        contents: [
          {
            parts: [{ text: kaiIntro }],
          },
          {
            parts: [{ text: prompt }],
          },
        ],
      },
      {
        headers: { "Content-Type": "application/json" },
      }
    );

    const reply = response.data.candidates?.[0]?.content?.parts?.[0]?.text || "😓 Kai is silent.";

    sessions[sessionId].push({ role: "assistant", content: reply });

    res.json({ message: reply });
  } catch (err) {
    console.error("❌ Gemini API error:", err.response?.data || err.message);
    res.status(500).json({ message: "😓 Kai is frozen. Please try again." });
  }
});

// GET endpoint
app.get("/chat", async (req, res) => {
  const prompt = req.query.query;
  const sessionId = req.query.sessionId;

  if (!prompt || !sessionId) {
    return res.status(400).json({ message: "Missing 'query' or 'sessionId'" });
  }

  if (!sessions[sessionId]) initializeSession(sessionId);

  sessions[sessionId].push({ role: "user", content: prompt });

  try {
    const response = await axios.post(
      `${API_URL}?key=${API_KEY}`,
      {
        contents: [
          {
            parts: [{ text: kaiIntro }],
          },
          {
            parts: [{ text: prompt }],
          },
        ],
      },
      {
        headers: { "Content-Type": "application/json" },
      }
    );

    const reply = response.data.candidates?.[0]?.content?.parts?.[0]?.text || "😓 Kai is silent.";

    sessions[sessionId].push({ role: "assistant", content: reply });

    res.json({ message: reply });
  } catch (err) {
    console.error("❌ Gemini API error:", err.response?.data || err.message);
    res.status(500).json({ message: "😓 Kai is frozen. Please try again." });
  }
});

app.listen(PORT, () => {
  console.log(`⚡ Kai API running on port ${PORT}`);
});
