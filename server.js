import "dotenv/config";
import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import { GoogleGenAI } from "@google/genai";
import mongoose from "mongoose";

const app = express();
app.use(bodyParser.json());
app.use(cors({ origin: ["http://localhost:5173", "http://localhost:5174"] }));

const PORT = 5000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!GEMINI_API_KEY) {
  console.error("GEMINI_API_KEY not set in .env!");
  process.exit(1);
}

mongoose
  .connect(process.env.MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  })
  .then(() => console.log("Connected to MongoDB"))
  .catch((err) => console.error("Failed to connect to MongoDB", err));

// MongoDB schema and model definition for Candidate
const candidateSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    phone: { type: String, required: true },
    status: { type: String, default: "not-started" },
    score: { type: Number, default: 0 },
    answers: [
      {
        question: String,
        answer: String,
        score: Number,
        feedback: String,
      },
    ],
    summary: { type: String, default: "" },
  },
  { timestamps: true }
);

const Candidate = mongoose.model("Candidate", candidateSchema);
// Initialize Gemini client
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

// Function to call Gemini
async function callGemini(prompt) {
  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.0-flash", // Replace with the appropriate model ID
      contents: prompt,
    });

    return response.text;
  } catch (err) {
    console.error("Error calling Gemini:", err);
    return "";
  }
}
app.post("/api/candidates", async (req, res) => {
  const {
    name,
    email,
    phone,
    status,
    score = 0,
    answers = [],
    summary = "",
  } = req.body;

  const candidate = new Candidate({
    name,
    email,
    phone,
    status: status || "not-started",
    score,
    answers,
    summary,
  });

  try {
    await candidate.save();
    res.status(201).json(candidate);
  } catch (err) {
    console.error("Error saving candidate:", err);
    res.status(500).json({ message: "Error saving candidate data" });
  }
});

app.get("/api/candidates", async (req, res) => {
  try {
    const { email } = req.query;
    let query = {};

    // If email parameter is provided, filter by email
    if (email) {
      query.email = email;
    }

    const candidates = await Candidate.find(query);
    res.json(candidates);
  } catch (err) {
    console.error("Error fetching candidates:", err);
    res.status(500).json({ message: "Error fetching candidate data" });
  }
});

app.put("/api/candidates/:id", async (req, res) => {
  const { id } = req.params;
  const { updates } = req.body;

  try {
    const updatedCandidate = await Candidate.findByIdAndUpdate(id, updates, {
      new: true,
    });
    res.json(updatedCandidate);
  } catch (err) {
    console.error("Error updating candidate:", err);
    res.status(500).json({ message: "Error updating candidate" });
  }
});

// Clean up duplicate candidates by email (keep only the most recent one)
app.post("/api/candidates/cleanup-duplicates", async (req, res) => {
  try {
    const duplicates = await Candidate.aggregate([
      {
        $group: {
          _id: "$email",
          count: { $sum: 1 },
          docs: { $push: "$$ROOT" },
        },
      },
      {
        $match: { count: { $gt: 1 } },
      },
    ]);

    let removed = 0;
    for (const dup of duplicates) {
      // Sort by createdAt (most recent first) and keep the first one
      const sorted = dup.docs.sort(
        (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
      );
      const toKeep = sorted[0];
      const toRemove = sorted.slice(1);

      // Remove duplicates
      for (const doc of toRemove) {
        await Candidate.findByIdAndDelete(doc._id);
        removed++;
      }
      console.log(
        `Kept candidate ${toKeep._id}, removed ${toRemove.length} duplicates for ${dup._id}`
      );
    }

    res.json({
      message: `Cleanup complete. Removed ${removed} duplicate candidates.`,
      removed,
    });
  } catch (err) {
    console.error("Error cleaning up duplicates:", err);
    res.status(500).json({ message: "Error cleaning up duplicates" });
  }
});
// Generate questions
app.post("/api/generateQuestions", async (req, res) => {
  const prompt = `
You are an AI interview assistant.
Generate 6 technical questions  for full stack (React/Node) role (2 Easy → 2 Medium → 2 Hard).
Timers per question: Easy 20s, Medium 60s, Hard 120s.
ONLY RETURN A JSON ARRAY OF OBJECTS. DO NOT ADD ANY TEXT OUTSIDE JSON.

Example format:
[
  { "q": "Question text", "difficulty": "easy", "time": 20 },
  { "q": "Question text", "difficulty": "easy", "time": 20 },
  { "q": "Question text", "difficulty": "medium", "time": 60 },
  { "q": "Question text", "difficulty": "medium", "time": 60 },
  { "q": "Question text", "difficulty": "hard", "time": 120 },
  { "q": "Question text", "difficulty": "hard", "time": 120 }
]


`;

  try {
    const result = await ai.models.generateContent({
      model: "gemini-2.0-flash",
      contents: prompt,
    });
    let text = result.text;

    // clean JSON (strip ```json … ``` if present)
    const cleaned = text.replace(/```json|```/g, "").trim();

    let questions = JSON.parse(cleaned).map((q) => ({
      ...q,
      time: Number(q.time) || 0, // force numeric
    }));

    res.json({ questions });
  } catch (err) {
    console.error("Error generating questions:", err);
    res.status(500).json({
      questions: [
        {
          q: "Explain event delegation in JavaScript.",
          difficulty: "easy",
          time: 20,
        },
        { q: "What are React hooks?", difficulty: "easy", time: 20 },
        {
          q: "How does Node.js handle asynchronous operations?",
          difficulty: "medium",
          time: 60,
        },
        { q: "Explain middleware in Express.", difficulty: "medium", time: 60 },
        {
          q: "Design a scalable folder structure for a MERN project.",
          difficulty: "hard",
          time: 120,
        },
        {
          q: "How would you optimize a React app for performance?",
          difficulty: "hard",
          time: 120,
        },
      ],
    });
  }
});

// Evaluate answer
// Evaluate answer
app.post("/api/evaluateAnswer", async (req, res) => {
  try {
    const { question, answer, resumeContext } = req.body;

    const prompt = `
You are a STRICT interview evaluator for a Full Stack (React/Node.js) role.
Grade the candidate's answer VERY STRICTLY out of 10. Be harsh with scoring.

STRICT EVALUATION CRITERIA:
- Technical correctness (40% weight): Must be technically accurate and demonstrate proper knowledge
- Depth of explanation (25% weight): Must show deep understanding, not surface-level answers
- Relevance to the question (20% weight): Must directly address the question asked
- Clarity and completeness (15% weight): Must be well-structured and complete

SCORING GUIDELINES:
- 9-10: Exceptional answer with deep technical insight, perfect understanding
- 7-8: Good answer with solid technical knowledge, minor gaps
- 5-6: Average answer with basic understanding, some technical errors
- 3-4: Poor answer with significant gaps or errors, minimal understanding
- 1-2: Very poor answer with major errors or irrelevant content
- 0: No answer, completely irrelevant, or shows no understanding

PENALTY FOR:
- Vague or generic answers ("blah blah blah", "I don't know", "not sure")
- Answers that don't address the specific question
- Technical inaccuracies or misconceptions
- Incomplete or rushed responses
- Copy-paste or template-like answers

Return ONLY valid JSON in this format:
{
  "score": number (0-10),
  "feedback": "constructive feedback explaining the score (2-3 sentences)"
}

Question: "${question}"
Answer: "${answer || "No Answer"}"
Candidate Resume Context: ${resumeContext}
`;

    const aiResponse = await callGemini(prompt);
    let cleaned = aiResponse.trim().replace(/```json|```/g, "");

    let result;
    try {
      result = JSON.parse(cleaned);

      // Enforce bounds
      if (
        typeof result.score !== "number" ||
        result.score < 0 ||
        result.score > 10
      ) {
        result.score = 0;
      }
      if (!result.feedback) {
        result.feedback = "No feedback generated.";
      }
    } catch (err) {
      console.warn("Gemini parse error, fallback used:", aiResponse);
      // Be strict with fallback scoring
      const answerQuality = (answer || "").toLowerCase();
      let fallbackScore = 0;
      let fallbackFeedback = "Answer could not be evaluated properly.";

      if (
        answerQuality.includes("blah") ||
        answerQuality.includes("not sure") ||
        answerQuality.includes("don't know") ||
        answerQuality.length < 10
      ) {
        fallbackScore = 0;
        fallbackFeedback =
          "Answer appears to be incomplete, vague, or shows no understanding of the question.";
      } else if (answerQuality.length < 50) {
        fallbackScore = 2;
        fallbackFeedback =
          "Answer is too brief and lacks sufficient detail to demonstrate understanding.";
      } else if (answerQuality.length < 100) {
        fallbackScore = 4;
        fallbackFeedback =
          "Answer is somewhat relevant but lacks depth and technical detail.";
      } else {
        fallbackScore = 5;
        fallbackFeedback =
          "Answer shows some understanding but could not be fully evaluated.";
      }

      result = {
        score: fallbackScore,
        feedback: fallbackFeedback,
      };
    }

    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to evaluate answer" });
  }
});
// Generate final summary for candidate after interview
app.post("/api/finalSummary", async (req, res) => {
  try {
    const { answers, resumeContext } = req.body;

    // Construct the AI prompt
    const prompt = `
    You are an AI interview evaluator.

    The candidate answered the following questions:
    ${answers
      .map(
        (a, i) =>
          `${i + 1}. Q: ${a.question} A: ${a.answer} Score: ${
            a.score
          } Feedback: ${a.feedback}`
      )
      .join("\n")}

    Provide a concise 3-4 line professional summary of the candidate's performance, strengths, weaknesses, and overall readiness for a full stack role.
    Return ONLY the summary text directly, no JSON formatting, no quotes, no brackets.
    `;

    // Call Gemini API to get the summary
    const aiResponse = await callGemini(prompt);

    if (!aiResponse) {
      throw new Error("Failed to generate AI summary");
    }

    console.log("Raw AI response:", aiResponse);

    let result;
    try {
      // Clean the response if needed
      let cleaned = aiResponse.trim();
      if (cleaned.startsWith("```")) {
        cleaned = cleaned.replace(/```json|```/g, "").trim();
      }

      // Remove any JSON formatting if AI still returns it
      if (cleaned.startsWith("{") && cleaned.includes('"summary"')) {
        try {
          const parsed = JSON.parse(cleaned);
          cleaned = parsed.summary || cleaned;
        } catch (e) {
          // If parsing fails, try to extract text between quotes
          const match = cleaned.match(/"summary":\s*"([^"]+)"/);
          if (match) {
            cleaned = match[1];
          }
        }
      }

      console.log("Cleaned summary:", cleaned);
      result = { summary: cleaned };
    } catch (error) {
      console.error("Error cleaning AI response:", error);
      result = {
        summary:
          "Candidate completed the interview. Performance details available in individual feedbacks.",
      };
    }

    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to generate final summary" });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
