const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");

const app = express();

// =========================
// ✅ MIDDLEWARES
// =========================
// ✅ CORS: Allow any Vercel deploy, any Render deploy, and localhost
// This means you NEVER need to update this file when you redeploy frontend.
app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true); // Postman / mobile / same-origin
    const allowed =
      origin.endsWith(".vercel.app") ||
      origin.endsWith(".onrender.com") ||
      origin === "http://127.0.0.1:5500" ||
      origin === "http://localhost:5500" ||
      origin === "http://localhost:3000";
    if (allowed) return callback(null, true);
    console.warn("⚠️ CORS blocked origin:", origin);
    return callback(new Error("Not allowed by CORS"));
  },
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true
}));

// Handle preflight requests
app.options("*", cors());

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// =========================
// 📦 MONGODB CONNECTION
// =========================
// ✅ CRITICAL: Use environment variable - never hardcode credentials
const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
  console.error("❌ MONGODB_URI environment variable is not set!");
  console.error("Please configure it in Render dashboard: Settings > Environment");
  process.exit(1);
}

console.log("🔄 Attempting MongoDB connection...");
console.log("📍 Using environment variable for connection");

// Improved connection options for better reliability
mongoose.connect(MONGODB_URI, {
  serverSelectionTimeoutMS: 5000,
  socketTimeoutMS: 45000,
})
  .then(() => {
    console.log("✅ MongoDB Connected Successfully");
    console.log("📦 Database:", mongoose.connection.name);
  })
  .catch((err) => {
    console.error("❌ MongoDB Connection Error:", err.message);
    console.error("Full error:", err);
    // Don't exit immediately - let Render retry
    console.error("⚠️ Will retry connection...");
  });

// Handle MongoDB connection events
mongoose.connection.on('disconnected', () => {
  console.warn("⚠️ MongoDB disconnected. Will attempt to reconnect...");
});

mongoose.connection.on('error', (err) => {
  console.error("❌ MongoDB error:", err.message);
});

mongoose.connection.on('reconnected', () => {
  console.log("✅ MongoDB reconnected");
});

// =========================
// 📋 SCHEMAS & MODELS
// =========================
const QuestionSchema = new mongoose.Schema({}, { strict: false });
const Question = mongoose.model("Question", QuestionSchema);

const resultSchema = new mongoose.Schema({
  name: String,
  score: Number,
  total: Number,
  type: String,
  date: String,
}, { timestamps: true });

const Result = mongoose.model("Result", resultSchema);

// =========================
// 🏠 HEALTH CHECK
// =========================
app.get("/", (req, res) => {
  res.json({ 
    message: "PrepXpert Backend API 🚀", 
    status: "healthy", 
    timestamp: new Date().toISOString(),
    mongodb: mongoose.connection.readyState === 1 ? "connected" : "disconnected",
    env: process.env.NODE_ENV || "development"
  });
});

app.get("/health", (req, res) => {
  const dbStatus = mongoose.connection.readyState;
  const isHealthy = dbStatus === 1;
  
  res.status(isHealthy ? 200 : 503).json({ 
    status: isHealthy ? "ok" : "degraded", 
    uptime: process.uptime(),
    mongodb: {
      status: dbStatus === 1 ? "connected" : "disconnected",
      readyState: dbStatus
    },
    timestamp: new Date().toISOString()
  });
});

// =========================
// 📚 QUESTIONS
// =========================
app.get("/questions", async (req, res) => {
  try {
    const data = await Question.find();
    console.log(`📖 Fetched ${data.length} questions`);
    res.json(data);
  } catch (error) {
    console.error("❌ Error fetching questions:", error);
    res.status(500).json({ error: "Failed to fetch questions", message: error.message });
  }
});

app.post("/add-questions", async (req, res) => {
  try {
    if (!req.body || !Array.isArray(req.body)) {
      return res.status(400).json({ error: "Expected an array of questions." });
    }
    const result = await Question.insertMany(req.body);
    console.log(`✅ Added ${result.length} questions to database`);
    res.json({ success: true, count: result.length, message: `${result.length} questions added` });
  } catch (error) {
    console.error("❌ Error adding questions:", error);
    res.status(500).json({ error: "Failed to add questions", message: error.message });
  }
});

app.delete("/clear-questions", async (req, res) => {
  try {
    const result = await Question.deleteMany({});
    console.log(`🗑️ Deleted ${result.deletedCount} questions`);
    res.json({ success: true, message: "All questions deleted ✅", deletedCount: result.deletedCount });
  } catch (error) {
    console.error("❌ Error clearing questions:", error);
    res.status(500).json({ error: "Failed to clear questions", message: error.message });
  }
});

// Keep legacy GET route for backwards compatibility
app.get("/clear-questions", async (req, res) => {
  try {
    const result = await Question.deleteMany({});
    res.json({ success: true, message: "All questions deleted ✅", deletedCount: result.deletedCount });
  } catch (error) {
    res.status(500).json({ error: "Failed to clear questions", message: error.message });
  }
});

// =========================
// 📊 RESULTS
// =========================
app.post("/save-result", async (req, res) => {
  try {
    const { name, score, total, type } = req.body;
    if (!name || score === undefined || total === undefined || !type) {
      return res.status(400).json({ error: "Missing required fields: name, score, total, type" });
    }
    const newResult = new Result({
      name: name.trim(),
      score: Number(score),
      total: Number(total),
      type: type.toUpperCase(),
      date: new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }),
    });
    await newResult.save();
    console.log(`✅ Saved result for ${name}: ${score}/${total} (${type})`);
    res.json({ success: true, message: "Result saved ✅", data: newResult });
  } catch (error) {
    console.error("❌ Error saving result:", error);
    res.status(500).json({ error: "Failed to save result", message: error.message });
  }
});

app.get("/results", async (req, res) => {
  try {
    const results = await Result.find().sort({ score: -1 });
    console.log(`📊 Fetched ${results.length} results (sorted by score)`);
    res.json(results);
  } catch (error) {
    console.error("❌ Error fetching results:", error);
    res.status(500).json({ error: "Failed to fetch results", message: error.message });
  }
});

app.get("/get-results", async (req, res) => {
  try {
    const results = await Result.find();
    console.log(`📊 Fetched ${results.length} results (unsorted)`);
    res.json(results);
  } catch (error) {
    console.error("❌ Error fetching results:", error);
    res.status(500).json({ error: "Failed to fetch results", message: error.message });
  }
});

app.delete("/clear-results", async (req, res) => {
  try {
    const result = await Result.deleteMany({});
    console.log(`🗑️ Deleted ${result.deletedCount} results`);
    res.json({ success: true, message: "All results deleted ✅", deletedCount: result.deletedCount });
  } catch (error) {
    console.error("❌ Error clearing results:", error);
    res.status(500).json({ error: "Failed to clear results", message: error.message });
  }
});

// Keep legacy GET route for backwards compatibility
app.get("/clear-results", async (req, res) => {
  try {
    const result = await Result.deleteMany({});
    res.json({ success: true, message: "All results deleted ✅", deletedCount: result.deletedCount });
  } catch (error) {
    res.status(500).json({ error: "Failed to clear results", message: error.message });
  }
});

// =========================
// 📈 STATS
// =========================
app.get("/stats", async (req, res) => {
  try {
    const questionCount = await Question.countDocuments();
    const resultCount = await Result.countDocuments();
    console.log(`📊 Stats - Questions: ${questionCount}, Results: ${resultCount}`);
    res.json({ 
      questions: questionCount, 
      results: resultCount, 
      timestamp: new Date().toISOString() 
    });
  } catch (error) {
    console.error("❌ Error fetching stats:", error);
    res.status(500).json({ error: "Failed to fetch stats", message: error.message });
  }
});

// =========================
// ❌ 404 HANDLER
// =========================
app.use((req, res) => {
  console.warn(`⚠️ 404 - Route not found: ${req.method} ${req.path}`);
  res.status(404).json({ 
    error: "Not Found", 
    message: `Route ${req.method} ${req.path} does not exist`,
    availableRoutes: [
      "GET /",
      "GET /health",
      "GET /questions",
      "POST /add-questions",
      "GET /clear-questions",
      "POST /save-result",
      "GET /results",
      "GET /get-results",
      "GET /clear-results",
      "GET /stats"
    ]
  });
});

// =========================
// 🚀 START SERVER
// =========================
const PORT = process.env.PORT || 5000;

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log("════════════════════════════════════════════");
  console.log(`🚀 PrepXpert Server running on port ${PORT}`);
  console.log(`📍 Environment: ${process.env.NODE_ENV || "development"}`);
  console.log(`🌐 MongoDB: ${mongoose.connection.readyState === 1 ? "✅ Connected" : "⏳ Connecting..."}`);
  console.log("════════════════════════════════════════════");
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server');
  server.close(() => {
    console.log('HTTP server closed');
    mongoose.connection.close(false, () => {
      console.log('MongoDB connection closed');
      process.exit(0);
    });
  });
});
