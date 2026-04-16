const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");

const app = express();

// =========================
// 🔧 CONFIGURATION
// =========================
const PORT = process.env.PORT || 5000;
const MONGODB_URI = process.env.MONGODB_URI;
const NODE_ENV = process.env.NODE_ENV || "development";

// =========================
// ✅ STARTUP VALIDATION
// =========================
console.log("════════════════════════════════════════════");
console.log("🚀 PrepXpert Backend Starting...");
console.log("📍 Environment:", NODE_ENV);
console.log("📍 Port:", PORT);
console.log("════════════════════════════════════════════");

if (!MONGODB_URI) {
  console.error("════════════════════════════════════════════");
  console.error("❌ CRITICAL ERROR: MONGODB_URI not configured!");
  console.error("════════════════════════════════════════════");
  console.error("");
  console.error("🔧 HOW TO FIX:");
  console.error("1. Go to Render Dashboard");
  console.error("2. Select your service");
  console.error("3. Go to 'Environment' tab");
  console.error("4. Add environment variable:");
  console.error("   Key: MONGODB_URI");
  console.error("   Value: mongodb+srv://admin:password@cluster.mongodb.net/prepxpert");
  console.error("5. Save and redeploy");
  console.error("");
  console.error("════════════════════════════════════════════");
  process.exit(1);
}

// =========================
// ✅ MIDDLEWARES
// =========================
const allowedOrigins = [
  "https://prep-xpert-omega.vercel.app",
  "http://127.0.0.1:5500",
  "http://localhost:5500",
  "http://localhost:3000"
];

// CORS configuration
app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (mobile apps, curl, Postman)
    if (!origin) return callback(null, true);
    
    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    
    console.warn("⚠️ CORS blocked origin:", origin);
    return callback(new Error("Not allowed by CORS"));
  },
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true
}));

// Handle preflight requests
app.options("*", cors());

// Body parsing middleware
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// Request logging middleware (only in development)
if (NODE_ENV === "development") {
  app.use((req, res, next) => {
    console.log(`${req.method} ${req.path}`);
    next();
  });
}

// =========================
// 📦 MONGODB CONNECTION
// =========================
console.log("🔄 Connecting to MongoDB...");

const mongooseOptions = {
  serverSelectionTimeoutMS: 5000,
  socketTimeoutMS: 45000,
};

mongoose.connect(MONGODB_URI, mongooseOptions)
  .then(() => {
    console.log("✅ MongoDB Connected Successfully");
    console.log("📦 Database:", mongoose.connection.name);
  })
  .catch((err) => {
    console.error("════════════════════════════════════════════");
    console.error("❌ MongoDB Connection Failed!");
    console.error("════════════════════════════════════════════");
    console.error("Error:", err.message);
    console.error("");
    
    if (err.message.includes("bad auth")) {
      console.error("🔧 FIX: Check your MongoDB username and password");
      console.error("   - Verify credentials in MongoDB Atlas");
      console.error("   - Update MONGODB_URI environment variable");
    } else if (err.message.includes("ETIMEDOUT") || err.message.includes("ECONNREFUSED")) {
      console.error("🔧 FIX: Check MongoDB Atlas Network Access");
      console.error("   - Go to MongoDB Atlas → Network Access");
      console.error("   - Add IP address: 0.0.0.0/0");
      console.error("   - Wait 2 minutes for changes to apply");
    } else {
      console.error("🔧 FIX: Check your MONGODB_URI format");
      console.error("   Should be: mongodb+srv://user:pass@cluster.mongodb.net/dbname");
    }
    
    console.error("════════════════════════════════════════════");
    console.error("⚠️ Server will continue, but database features won't work");
    console.error("════════════════════════════════════════════");
  });

// MongoDB connection event handlers
mongoose.connection.on('disconnected', () => {
  console.warn("⚠️ MongoDB disconnected. Attempting to reconnect...");
});

mongoose.connection.on('error', (err) => {
  console.error("❌ MongoDB error:", err.message);
});

mongoose.connection.on('reconnected', () => {
  console.log("✅ MongoDB reconnected successfully");
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
// 🏠 HEALTH CHECK & ROOT
// =========================
app.get("/", (req, res) => {
  const dbState = mongoose.connection.readyState;
  const dbStatus = {
    0: "disconnected",
    1: "connected",
    2: "connecting",
    3: "disconnecting"
  };

  res.json({ 
    message: "PrepXpert Backend API 🚀", 
    status: "healthy", 
    version: "1.0.0",
    timestamp: new Date().toISOString(),
    environment: NODE_ENV,
    mongodb: {
      status: dbStatus[dbState] || "unknown",
      readyState: dbState
    }
  });
});

app.get("/health", (req, res) => {
  const dbState = mongoose.connection.readyState;
  const isHealthy = dbState === 1;
  
  res.status(isHealthy ? 200 : 503).json({ 
    status: isHealthy ? "healthy" : "degraded", 
    uptime: Math.floor(process.uptime()),
    mongodb: {
      connected: isHealthy,
      readyState: dbState
    },
    timestamp: new Date().toISOString()
  });
});

// =========================
// 📚 QUESTIONS ROUTES
// =========================
app.get("/questions", async (req, res) => {
  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ 
        error: "Database not connected",
        message: "Please try again in a moment"
      });
    }

    const data = await Question.find();
    console.log(`📖 Fetched ${data.length} questions`);
    res.json(data);
  } catch (error) {
    console.error("❌ Error fetching questions:", error.message);
    res.status(500).json({ 
      error: "Failed to fetch questions", 
      message: error.message 
    });
  }
});

app.post("/add-questions", async (req, res) => {
  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ 
        error: "Database not connected",
        message: "Please try again in a moment"
      });
    }

    if (!req.body || !Array.isArray(req.body)) {
      return res.status(400).json({ 
        error: "Invalid input", 
        message: "Expected an array of questions" 
      });
    }

    if (req.body.length === 0) {
      return res.status(400).json({ 
        error: "Empty array", 
        message: "No questions to add" 
      });
    }

    const result = await Question.insertMany(req.body);
    console.log(`✅ Added ${result.length} questions`);
    
    res.json({ 
      success: true, 
      count: result.length, 
      message: `${result.length} questions added successfully` 
    });
  } catch (error) {
    console.error("❌ Error adding questions:", error.message);
    res.status(500).json({ 
      error: "Failed to add questions", 
      message: error.message 
    });
  }
});

app.get("/clear-questions", async (req, res) => {
  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ 
        error: "Database not connected",
        message: "Please try again in a moment"
      });
    }

    const result = await Question.deleteMany({});
    console.log(`🗑️ Deleted ${result.deletedCount} questions`);
    
    res.json({ 
      success: true, 
      message: "All questions deleted", 
      deletedCount: result.deletedCount 
    });
  } catch (error) {
    console.error("❌ Error clearing questions:", error.message);
    res.status(500).json({ 
      error: "Failed to clear questions", 
      message: error.message 
    });
  }
});

// =========================
// 📊 RESULTS ROUTES
// =========================
app.post("/save-result", async (req, res) => {
  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ 
        error: "Database not connected",
        message: "Please try again in a moment"
      });
    }

    const { name, score, total, type } = req.body;
    
    // Validation
    if (!name || score === undefined || total === undefined || !type) {
      return res.status(400).json({ 
        error: "Missing fields", 
        message: "Required: name, score, total, type" 
      });
    }

    const newResult = new Result({
      name: name.trim(),
      score: Number(score),
      total: Number(total),
      type: type.toUpperCase(),
      date: new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }),
    });

    await newResult.save();
    console.log(`✅ Saved result: ${name} - ${score}/${total} (${type})`);
    
    res.json({ 
      success: true, 
      message: "Result saved successfully", 
      data: newResult 
    });
  } catch (error) {
    console.error("❌ Error saving result:", error.message);
    res.status(500).json({ 
      error: "Failed to save result", 
      message: error.message 
    });
  }
});

app.get("/results", async (req, res) => {
  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ 
        error: "Database not connected",
        message: "Please try again in a moment"
      });
    }

    const results = await Result.find().sort({ score: -1 });
    console.log(`📊 Fetched ${results.length} results (sorted)`);
    res.json(results);
  } catch (error) {
    console.error("❌ Error fetching results:", error.message);
    res.status(500).json({ 
      error: "Failed to fetch results", 
      message: error.message 
    });
  }
});

app.get("/get-results", async (req, res) => {
  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ 
        error: "Database not connected",
        message: "Please try again in a moment"
      });
    }

    const results = await Result.find();
    console.log(`📊 Fetched ${results.length} results`);
    res.json(results);
  } catch (error) {
    console.error("❌ Error fetching results:", error.message);
    res.status(500).json({ 
      error: "Failed to fetch results", 
      message: error.message 
    });
  }
});

app.get("/clear-results", async (req, res) => {
  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ 
        error: "Database not connected",
        message: "Please try again in a moment"
      });
    }

    const result = await Result.deleteMany({});
    console.log(`🗑️ Deleted ${result.deletedCount} results`);
    
    res.json({ 
      success: true, 
      message: "All results deleted", 
      deletedCount: result.deletedCount 
    });
  } catch (error) {
    console.error("❌ Error clearing results:", error.message);
    res.status(500).json({ 
      error: "Failed to clear results", 
      message: error.message 
    });
  }
});

// =========================
// 📈 STATS ROUTE
// =========================
app.get("/stats", async (req, res) => {
  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ 
        error: "Database not connected",
        message: "Please try again in a moment"
      });
    }

    const questionCount = await Question.countDocuments();
    const resultCount = await Result.countDocuments();
    
    console.log(`📊 Stats - Questions: ${questionCount}, Results: ${resultCount}`);
    
    res.json({ 
      questions: questionCount, 
      results: resultCount, 
      timestamp: new Date().toISOString() 
    });
  } catch (error) {
    console.error("❌ Error fetching stats:", error.message);
    res.status(500).json({ 
      error: "Failed to fetch stats", 
      message: error.message 
    });
  }
});

// =========================
// 🧪 TEST ROUTE (useful for debugging)
// =========================
app.get("/test", (req, res) => {
  res.json({
    message: "Test endpoint working! ✅",
    timestamp: new Date().toISOString(),
    server: "running",
    mongodb: mongoose.connection.readyState === 1 ? "connected" : "not connected"
  });
});

// =========================
// ❌ 404 HANDLER
// =========================
app.use((req, res) => {
  console.warn(`⚠️ 404: ${req.method} ${req.path}`);
  res.status(404).json({ 
    error: "Route not found", 
    path: req.path,
    method: req.method,
    availableRoutes: [
      "GET /",
      "GET /health",
      "GET /test",
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
// ⚠️ ERROR HANDLER
// =========================
app.use((err, req, res, next) => {
  console.error("❌ Server error:", err.message);
  console.error(err.stack);
  
  res.status(500).json({
    error: "Internal server error",
    message: err.message,
    path: req.path
  });
});

// =========================
// 🚀 START SERVER
// =========================
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log("════════════════════════════════════════════");
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`🌐 Environment: ${NODE_ENV}`);
  console.log(`🔗 MongoDB: ${mongoose.connection.readyState === 1 ? "✅ Connected" : "⏳ Connecting..."}`);
  console.log("════════════════════════════════════════════");
  console.log("📍 Available routes:");
  console.log("   GET  /");
  console.log("   GET  /health");
  console.log("   GET  /test");
  console.log("   GET  /questions");
  console.log("   POST /add-questions");
  console.log("   GET  /clear-questions");
  console.log("   POST /save-result");
  console.log("   GET  /results");
  console.log("   GET  /get-results");
  console.log("   GET  /clear-results");
  console.log("   GET  /stats");
  console.log("════════════════════════════════════════════");
});

// =========================
// 🛑 GRACEFUL SHUTDOWN
// =========================
const gracefulShutdown = (signal) => {
  console.log(`\n${signal} received. Starting graceful shutdown...`);
  
  server.close(() => {
    console.log("✅ HTTP server closed");
    
    mongoose.connection.close(false, () => {
      console.log("✅ MongoDB connection closed");
      console.log("👋 Shutdown complete");
      process.exit(0);
    });
  });

  // Force shutdown after 10 seconds
  setTimeout(() => {
    console.error("⚠️ Forced shutdown after timeout");
    process.exit(1);
  }, 10000);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// =========================
// 🔥 UNCAUGHT ERROR HANDLERS
// =========================
process.on('uncaughtException', (err) => {
  console.error("════════════════════════════════════════════");
  console.error("❌ UNCAUGHT EXCEPTION:");
  console.error(err);
  console.error("════════════════════════════════════════════");
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error("════════════════════════════════════════════");
  console.error("❌ UNHANDLED REJECTION:");
  console.error("Reason:", reason);
  console.error("════════════════════════════════════════════");
});
