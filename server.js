require('dotenv').config();
const express = require("express");
const mongoose = require("mongoose");
const cors    = require("cors");
const crypto  = require("crypto");

const app = express();

// ══════════════════════════════════════════════
// ✅ ENVIRONMENT VALIDATION — fail fast on boot
// ══════════════════════════════════════════════
const REQUIRED_ENV = [
  "MONGODB_URI",
  "RAZORPAY_KEY_ID",
  "RAZORPAY_KEY_SECRET",
  "UNLOCK_TOKEN_SECRET",
  "ADMIN_API_KEY",
];
const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length) {
  console.error("❌ Missing env vars:", missing.join(", "));
  console.error("Add them in Render → Settings → Environment Variables");
  process.exit(1);
}

// ══════════════════════════════════════════════
// ✅ MIDDLEWARES
// ══════════════════════════════════════════════
app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true);
    const ok = 
      origin.endsWith(".netlify.app") ||
      origin.endsWith(".vercel.app") ||
      origin.endsWith(".onrender.com") ||
      origin === "http://127.0.0.1:5500" ||
      origin === "http://localhost:5500" ||
      origin === "http://localhost:3000";
    if (ok) return cb(null, true);
    console.warn("⚠️ CORS blocked:", origin);
    cb(new Error("Not allowed by CORS"));
  },
  methods: ["GET", "POST", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "x-admin-key", "x-unlock-token", "x-mobile"],
  credentials: true,
}));
app.options("*", cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// ══════════════════════════════════════════════
// 🛡️ IN-MEMORY RATE LIMITER
// ══════════════════════════════════════════════
const _rl = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _rl) if (now > v.resetAt) _rl.delete(k);
}, 10 * 60 * 1000);

function rateLimit(max, windowMs) {
  return (req, res, next) => {
    const key = (req.ip || "x") + ":" + req.path;
    const now = Date.now();
    const rec = _rl.get(key) || { count: 0, resetAt: now + windowMs };
    if (now > rec.resetAt) { rec.count = 0; rec.resetAt = now + windowMs; }
    rec.count++;
    _rl.set(key, rec);
    if (rec.count > max) {
      console.warn(`🚫 Rate limit: ${key} (${rec.count})`);
      return res.status(429).json({ error: "Too many requests. Wait and retry." });
    }
    next();
  };
}

// ══════════════════════════════════════════════
// 🔐 ADMIN MIDDLEWARE
// Admin routes require header:  x-admin-key: <ADMIN_API_KEY env var>
// ══════════════════════════════════════════════
function requireAdmin(req, res, next) {
  const key = req.headers["x-admin-key"] || "";
  if (!key || key !== process.env.ADMIN_API_KEY) {
    console.warn(`🚫 Unauthorized admin from ${req.ip}`);
    return res.status(403).json({ error: "Forbidden." });
  }
  next();
}

// ══════════════════════════════════════════════
// 📦 MONGODB
// ══════════════════════════════════════════════
mongoose.connect(process.env.MONGODB_URI, {
  serverSelectionTimeoutMS: 5000,
  socketTimeoutMS: 45000,
})
  .then(() => console.log("✅ MongoDB connected:", mongoose.connection.name))
  .catch(err => console.error("❌ MongoDB:", err.message));

mongoose.connection.on("disconnected", () => console.warn("⚠️ MongoDB disconnected"));
mongoose.connection.on("reconnected",  () => console.log("✅ MongoDB reconnected"));

// ══════════════════════════════════════════════
// 📋 SCHEMAS
// ══════════════════════════════════════════════

// Test metadata (no questions stored here)
const testSchema = new mongoose.Schema({
  name:     { type: String, required: true },
  stream:   { type: String, enum: ["pcm","pcb","neet","jee"], required: true },
  free:     { type: Boolean, default: false },
  active:   { type: Boolean, default: true },
  desc:     { type: String, default: "" },
  topics:   { type: Object, default: {} },
  duration: { type: Number, default: 180 },
}, { timestamps: true });
const Test = mongoose.model("Test", testSchema);

// Questions stored WITH answers in DB — answers NEVER sent to student browser
const questionSchema = new mongoose.Schema({
  testId:       { type: mongoose.Schema.Types.ObjectId, ref: "Test", required: true, index: true },
  section:      { type: Number, required: true },
  index:        { type: Number, required: true },
  q:            { type: String, required: true },
  opts:         [String],
  ans:          { type: Number },          // correct MCQ option index
  numericalAns: { type: String },          // correct numerical answer
  isNumerical:  { type: Boolean, default: false },
  sol:          { type: String, default: "" },
  img:          { type: String, default: "" },
}, { timestamps: true });
const Question = mongoose.model("Question", questionSchema);

// Results / leaderboard
const resultSchema = new mongoose.Schema({
  name:  { type: String, required: true, trim: true, maxlength: 100 },
  score: { type: Number, required: true },
  total: { type: Number, required: true },
  type:  { type: String, required: true, enum: ["PCM","PCB","NEET","JEE"] },
  date:  { type: String },
}, { timestamps: true });
const Result = mongoose.model("Result", resultSchema);

// Server-issued unlock tokens (stored after real Razorpay payment)
const unlockTokenSchema = new mongoose.Schema({
  token:     { type: String, required: true, unique: true, index: true },
  mobile:    { type: String, required: true },
  paymentId: { type: String, required: true },
  createdAt: { type: Date, default: Date.now, expires: 365 * 24 * 3600 }, // auto-delete after 1 year
});
const UnlockToken = mongoose.model("UnlockToken", unlockTokenSchema);

// ══════════════════════════════════════════════
// 💳 PAYMENT HELPERS
// ══════════════════════════════════════════════
function verifyRazorpaySignature(orderId, paymentId, signature) {
  try {
    const expected = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(`${orderId}|${paymentId}`)
      .digest("hex");
    return expected === signature;
  } catch { return false; }
}

async function fetchRazorpayPayment(paymentId) {
  const auth = Buffer.from(
    `${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`
  ).toString("base64");
  const r = await fetch(`https://api.razorpay.com/v1/payments/${paymentId}`, {
    headers: { Authorization: `Basic ${auth}` },
  });
  if (!r.ok) throw new Error(`Razorpay API ${r.status}`);
  return r.json();
}

function makeUnlockToken(mobile, paymentId) {
  return crypto
    .createHmac("sha256", process.env.UNLOCK_TOKEN_SECRET)
    .update(`${mobile}:${paymentId}:${Date.now()}`)
    .digest("hex");
}

// ══════════════════════════════════════════════
// 🏠 HEALTH
// ══════════════════════════════════════════════
app.get("/", (_, res) => res.json({ message: "PrepXpert API 🚀", status: "ok" }));

app.get("/health", (_, res) => {
  const db = mongoose.connection.readyState;
  res.status(db === 1 ? 200 : 503).json({
    status: db === 1 ? "ok" : "degraded",
    uptime: process.uptime(),
    mongodb: db === 1 ? "connected" : "disconnected",
  });
});

// ══════════════════════════════════════════════
// 🔓 PUBLIC — TESTS LIST (metadata only, NO questions/answers)
// ══════════════════════════════════════════════
app.get("/tests", async (req, res) => {
  try {
    const tests = await Test.find({ active: true })
      .select("name stream free desc topics duration")
      .lean();

    const ids    = tests.map(t => t._id);
    const counts = await Question.aggregate([
      { $match: { testId: { $in: ids } } },
      { $group: { _id: "$testId", count: { $sum: 1 } } },
    ]);
    const cm = Object.fromEntries(counts.map(c => [c._id.toString(), c.count]));

    res.json(tests.map(t => ({
      id:       t._id.toString(),
      name:     t.name,
      stream:   t.stream,
      free:     t.free,
      desc:     t.desc,
      topics:   t.topics,
      duration: t.duration,
      totalQ:   cm[t._id.toString()] || 0,
    })));
  } catch (err) {
    console.error("❌ /tests:", err.message);
    res.status(500).json({ error: "Failed to fetch tests" });
  }
});

// ══════════════════════════════════════════════
// 🔓 PUBLIC — LOAD EXAM (questions WITHOUT answers)
// For paid tests: must send x-unlock-token + x-mobile headers
// ══════════════════════════════════════════════
app.get("/exam/:testId",
  rateLimit(60, 60 * 1000),
  async (req, res) => {
    try {
      const { testId } = req.params;
      if (!mongoose.Types.ObjectId.isValid(testId))
        return res.status(400).json({ error: "Invalid test ID" });

      const test = await Test.findById(testId).select("name stream free active duration topics");
      if (!test || !test.active)
        return res.status(404).json({ error: "Test not found" });

      // Paid test — verify unlock token
      if (!test.free) {
        const token  = (req.headers["x-unlock-token"] || "").trim().slice(0, 128);
        const mobile = (req.headers["x-mobile"] || "").replace(/\D/g, "").slice(0, 15);
        if (!token || !mobile)
          return res.status(402).json({ error: "Payment required." });

        const valid = await UnlockToken.findOne({ token, mobile });
        if (!valid)
          return res.status(402).json({ error: "Invalid or expired unlock. Please re-verify payment." });
      }

      // ── CRITICAL: select excludes ans, numericalAns, sol ──
      const questions = await Question.find({ testId })
        .select("section index q opts isNumerical img")
        .sort({ section: 1, index: 1 })
        .lean();

      res.json({
        test: { id: test._id, name: test.name, stream: test.stream, duration: test.duration, topics: test.topics },
        questions,
      });
    } catch (err) {
      console.error("❌ /exam:", err.message);
      res.status(500).json({ error: "Failed to load exam" });
    }
  }
);

// ══════════════════════════════════════════════
// 🔓 PUBLIC — SUBMIT ANSWERS → server grades → returns results + solutions
// Answers and solutions are ONLY revealed here, after submission
// ══════════════════════════════════════════════
app.post("/submit",
  rateLimit(10, 5 * 60 * 1000),
  async (req, res) => {
    try {
      const { testId, mobile, name, answers } = req.body;
      if (!testId || !mobile || !name || !answers)
        return res.status(400).json({ error: "Missing testId, mobile, name, or answers" });
      if (!mongoose.Types.ObjectId.isValid(testId))
        return res.status(400).json({ error: "Invalid test ID" });

      const test = await Test.findById(testId);
      if (!test) return res.status(404).json({ error: "Test not found" });

      // Fetch ALL questions WITH correct answers (server-side only)
      const questions = await Question.find({ testId }).sort({ section:1, index:1 }).lean();

      const isNEET = test.stream === "neet";
      const isJEE  = test.stream === "jee";
      const cfg = {
        pcm:  [{ m:1,n:0 }, { m:1,n:0 }, { m:2,n:0 }],
        pcb:  [{ m:1,n:0 }, { m:1,n:0 }, { m:1,n:0 }],
        neet: [{ m:4,n:1 }, { m:4,n:1 }, { m:4,n:1 }],
        jee:  [{ m:4,n:1 }, { m:4,n:1 }, { m:4,n:1 }],
      }[test.stream] || [{ m:1,n:0 }, { m:1,n:0 }, { m:1,n:0 }];

      let totalScore=0, correct=0, wrong=0, skipped=0, deducted=0;
      const reviewList = [];

      for (const q of questions) {
        const key     = `${q.section}-${q.index}`;
        const given   = answers[key];
        const secCfg  = cfg[q.section] || { m:1, n:0 };
        let mark=0, status="skip";

        if (q.isNumerical) {
          const typed   = parseFloat(String(given ?? "").trim());
          const correct_val = parseFloat(q.numericalAns || String(q.ans));
          if (given === undefined || given === null || String(given).trim() === "") {
            status="skip"; skipped++;
          } else if (!isNaN(typed) && !isNaN(correct_val) && Math.abs(typed - correct_val) < 0.01) {
            mark=secCfg.m; status="correct"; correct++;
          } else {
            status="wrong"; wrong++;
          }
        } else {
          const chosen = (given === null || given === undefined) ? null : Number(given);
          if (chosen === null) {
            status="skip"; skipped++;
          } else if (chosen === q.ans) {
            mark=secCfg.m; status="correct"; correct++;
          } else {
            status="wrong"; wrong++;
            if (isNEET || isJEE) { mark = -secCfg.n; deducted += secCfg.n; }
          }
        }

        totalScore += mark;
        reviewList.push({
          section: q.section, index: q.index,
          q: q.q, opts: q.opts, img: q.img, isNumerical: q.isNumerical,
          ans: q.ans,               // correct answer — revealed only here
          numericalAns: q.numericalAns,
          sol: q.sol,               // solution — revealed only here
          given, status, mark,
        });
      }

      const totalMarks = questions.reduce((acc, q) => acc + (cfg[q.section]?.m || 1), 0);

      await Result.create({
        name:  name.trim().slice(0, 100),
        score: totalScore,
        total: totalMarks,
        type:  test.stream.toUpperCase(),
        date:  new Date().toISOString(),
      });

      console.log(`✅ Graded: ${name} → ${totalScore}/${totalMarks} (${test.stream.toUpperCase()})`);

      res.json({
        success: true,
        result:  { score: totalScore, total: totalMarks, correct, wrong, skipped, deducted,
                   accuracy: (correct+wrong)>0 ? Math.round(correct/(correct+wrong)*100) : 0 },
        review:  reviewList,
      });
    } catch (err) {
      console.error("❌ /submit:", err.message);
      res.status(500).json({ error: "Failed to grade submission" });
    }
  }
);

// ══════════════════════════════════════════════
// 💳 PAYMENT VERIFICATION
// ══════════════════════════════════════════════
app.post("/verify-payment",
  rateLimit(10, 15 * 60 * 1000),
  async (req, res) => {
    try {
      const { razorpay_payment_id, razorpay_order_id, razorpay_signature, userMobile } = req.body;
      if (!razorpay_payment_id || !userMobile)
        return res.status(400).json({ success: false, message: "Missing payment ID or mobile." });

      const paymentId = razorpay_payment_id.trim().slice(0, 64);
      const mobile    = userMobile.replace(/\D/g, "").slice(0, 15);

      // Replay attack prevention
      if (await UnlockToken.findOne({ paymentId })) {
        console.warn(`⚠️ Replay: ${paymentId}`);
        return res.status(409).json({ success: false, message: "Payment already used." });
      }

      let verified = false;

      // Method 1: Signature (order-based flow)
      if (razorpay_order_id && razorpay_signature) {
        verified = verifyRazorpaySignature(razorpay_order_id, paymentId, razorpay_signature);
        if (!verified)
          return res.status(400).json({ success: false, message: "Payment signature invalid." });
      }

      // Method 2: Direct Razorpay API (simple checkout)
      if (!verified) {
        const rzp = await fetchRazorpayPayment(paymentId);
        if (rzp.status !== "captured")
          return res.status(400).json({ success: false, message: `Payment not captured (${rzp.status})` });
        const expected = parseInt(process.env.PAYMENT_AMOUNT_PAISE || "3000");
        if (rzp.amount < expected)
          return res.status(400).json({ success: false, message: "Payment amount too low." });
        verified = true;
      }

      const token = makeUnlockToken(mobile, paymentId);
      await UnlockToken.create({ token, mobile, paymentId });
      console.log(`🔓 Unlock issued: ${mobile} (${paymentId})`);
      res.json({ success: true, token, message: "Payment verified. Tests unlocked!" });

    } catch (err) {
      console.error("❌ /verify-payment:", err.message);
      res.status(500).json({ success: false, message: "Server error." });
    }
  }
);

// ══════════════════════════════════════════════
// 🔒 CHECK UNLOCK (called on every app load)
// ══════════════════════════════════════════════
app.post("/check-unlock",
  rateLimit(30, 5 * 60 * 1000),
  async (req, res) => {
    try {
      const { token, mobile } = req.body;
      if (!token || !mobile) return res.status(400).json({ valid: false });
      const record = await UnlockToken.findOne({
        token:  token.trim().slice(0, 128),
        mobile: mobile.replace(/\D/g, "").slice(0, 15),
      });
      res.json({ valid: !!record });
    } catch (err) {
      console.error("❌ /check-unlock:", err.message);
      res.status(500).json({ valid: false });
    }
  }
);

// ══════════════════════════════════════════════
// 📊 RESULTS (public leaderboard)
// ══════════════════════════════════════════════
app.post("/save-result", rateLimit(20, 60 * 1000), async (req, res) => {
  try {
    const { name, score, total, type } = req.body;
    if (!name || score===undefined || !total || !type)
      return res.status(400).json({ error: "Missing fields" });
    if (!["PCM","PCB","NEET","JEE"].includes(type.toUpperCase()))
      return res.status(400).json({ error: "Invalid type" });
    await Result.create({
      name: name.trim().slice(0,100),
      score: Math.round(Number(score)),
      total: Math.round(Number(total)),
      type: type.toUpperCase(),
      date: new Date().toISOString(),
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to save result" });
  }
});

app.get("/results", async (req, res) => {
  try {
    const results = await Result.find()
      .sort({ score: -1 })
      .limit(500)
      .select("name score total type date -_id")
      .lean();
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch results" });
  }
});

// ══════════════════════════════════════════════
// 🔐 ADMIN ROUTES (require x-admin-key header)
// ══════════════════════════════════════════════

// Dashboard stats
app.get("/admin/stats", requireAdmin, async (req, res) => {
  try {
    const [tests, questions, results, unlocks] = await Promise.all([
      Test.countDocuments(), Question.countDocuments(),
      Result.countDocuments(), UnlockToken.countDocuments(),
    ]);
    res.json({ tests, questions, results, unlocks, uptime: process.uptime() });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Tests
app.get("/admin/tests", requireAdmin, async (req, res) => {
  try {
    const tests  = await Test.find().lean();
    const ids    = tests.map(t => t._id);
    const counts = await Question.aggregate([
      { $match: { testId: { $in: ids } } },
      { $group: { _id: "$testId", count: { $sum: 1 } } },
    ]);
    const cm = Object.fromEntries(counts.map(c => [c._id.toString(), c.count]));
    res.json(tests.map(t => ({ ...t, totalQ: cm[t._id.toString()] || 0 })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/admin/tests", requireAdmin, async (req, res) => {
  try {
    const { name, stream, free, desc, topics, duration } = req.body;
    if (!name || !stream) return res.status(400).json({ error: "name and stream required" });
    const t = await Test.create({ name, stream, free: !!free, desc: desc||"", topics: topics||{}, duration: duration||180 });
    console.log(`✅ Admin: created test "${name}"`);
    res.json({ success: true, id: t._id, test: t });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/admin/tests/:id", requireAdmin, async (req, res) => {
  try {
    const t = await Test.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!t) return res.status(404).json({ error: "Not found" });
    res.json({ success: true, test: t });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete("/admin/tests/:id", requireAdmin, async (req, res) => {
  try {
    await Question.deleteMany({ testId: req.params.id });
    await Test.findByIdAndDelete(req.params.id);
    console.log(`🗑️ Admin: deleted test ${req.params.id}`);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Questions (admin sees answers; students never do)
app.post("/admin/questions", requireAdmin, rateLimit(50, 60*1000), async (req, res) => {
  try {
    const { testId, questions, replace } = req.body;
    if (!testId || !Array.isArray(questions))
      return res.status(400).json({ error: "testId and questions[] required" });
    if (!mongoose.Types.ObjectId.isValid(testId))
      return res.status(400).json({ error: "Invalid testId" });

    if (replace) await Question.deleteMany({ testId });

    const docs = questions.map(q => ({
      testId,
      section:      Number(q.section ?? 0),
      index:        Number(q.index ?? 0),
      q:            String(q.q || ""),
      opts:         Array.isArray(q.opts) ? q.opts : [],
      ans:          q.ans !== undefined ? Number(q.ans) : undefined,
      numericalAns: q.numericalAns ? String(q.numericalAns) : undefined,
      isNumerical:  !!q.isNumerical,
      sol:          String(q.sol || ""),
      img:          String(q.img || ""),
    }));

    await Question.insertMany(docs, { ordered: false });
    console.log(`✅ Admin: imported ${docs.length} questions → test ${testId}`);
    res.json({ success: true, count: docs.length });
  } catch (err) {
    console.error("❌ /admin/questions:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/admin/questions/:testId", requireAdmin, async (req, res) => {
  try {
    const qs = await Question.find({ testId: req.params.testId }).sort({ section:1, index:1 });
    res.json(qs);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete("/admin/questions/:testId", requireAdmin, async (req, res) => {
  try {
    const r = await Question.deleteMany({ testId: req.params.testId });
    res.json({ success: true, deletedCount: r.deletedCount });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Results admin
app.get("/admin/results", requireAdmin, async (req, res) => {
  try {
    const r = await Result.find().sort({ createdAt: -1 }).limit(1000).lean();
    res.json(r);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete("/admin/results", requireAdmin, async (req, res) => {
  try {
    const r = await Result.deleteMany({});
    res.json({ success: true, deletedCount: r.deletedCount });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════
// 📊 PUBLIC STATS
// ══════════════════════════════════════════════
app.get("/stats", async (req, res) => {
  try {
    const [q, r] = await Promise.all([Question.countDocuments(), Result.countDocuments()]);
    res.json({ questions: q, results: r });
  } catch (err) { res.status(500).json({ error: "Failed" }); }
});

// ══════════════════════════════════════════════
// ❌ 404
// ══════════════════════════════════════════════
app.use((req, res) => {
  res.status(404).json({
    error: "Route not found",
    public: ["GET /health","GET /tests","GET /exam/:testId","POST /submit","POST /verify-payment","POST /check-unlock","POST /save-result","GET /results","GET /stats"],
    admin:  ["GET/POST /admin/tests","POST/DELETE /admin/tests/:id","POST /admin/questions","GET/DELETE /admin/questions/:testId","GET/DELETE /admin/results","GET /admin/stats"],
  });
});

// ══════════════════════════════════════════════
// 🚀 START
// ══════════════════════════════════════════════
const PORT = process.env.PORT || 5000;
const server = app.listen(PORT, "0.0.0.0", () => {
  console.log("════════════════════════════════════════════");
  console.log(`🚀 PrepXpert API on port ${PORT}`);
  console.log(`💳 Razorpay: ${process.env.RAZORPAY_KEY_ID?.startsWith("rzp_live") ? "✅ LIVE" : "⚠️ TEST MODE"}`);
  console.log("════════════════════════════════════════════");
});

process.on("SIGTERM", () => {
  server.close(() => mongoose.connection.close(false, () => process.exit(0)));
});
