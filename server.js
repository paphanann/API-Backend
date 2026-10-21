const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });



const express = require("express");
const cors = require("cors");

const connectionRoutes = require("./routes/connectionRoutes");
const orderRoutes = require("./routes/orderRoutes");
const productRoutes = require("./routes/productRoutes");
const inventoryRoutes = require("./routes/inventoryRoutes");
const stockTransferRoutes = require("./routes/stockTransferRoutes");
const syncRoutes = require("./routes/syncRoutes");
const authRoutes = require("./routes/authRoutes");
const settingsRoutes = require("./routes/settingsRoutes");
const usersRoutes = require("./routes/usersRoutes");
const tiktokRoutes = require("./routes/oauth/tiktokRoutes");
const lazadaRoutes = require("./routes/oauth/lazadaRoutes");
const shopeeService = require("./services/marketplaces/shopeeService");
const tiktokService = require("./services/marketplaces/tiktokService");
const lazadaService = require("./services/marketplaces/lazadaService");
const { ensureSchema } = require("./services/stores/schema");
const { startTokenRefreshJob } = require("./services/sync/tokenRefreshJob");
const { startOrderSyncJob } = require("./services/sync/orderSyncJob");
const { startSapMapJob } = require("./services/marketplaces/sapService");
const dashboardRoutes = require("./routes/dashboardRoutes");
const { poolPromise } = require("./config/database");
const { startTimer } = require("./utils/timing");

const app = express();
app.set("trust proxy", 1);

const allowedOrigins = (process.env.FRONTEND_URL || "http://localhost:5173")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

function isAllowedOrigin(origin) {
  if (!origin) {
    return true;
  }

  if (allowedOrigins.includes(origin)) {
    return true;
  }

  try {
    const { hostname } = new URL(origin);
    return hostname === "localhost" || hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

app.use((req, res, next) => {
  const asksForLocal = String(req.headers["access-control-request-private-network"] || "")
    .trim()
    .toLowerCase();
  if (asksForLocal === "true") {
    res.setHeader("Access-Control-Allow-Private-Network", "true");
  }
  next();
});

app.use(
  cors({
    origin(origin, callback) {
      callback(null, isAllowedOrigin(origin));
    },
    credentials: true,
  })
);



app.use(express.json());

// ngrok free บางทีโชว์หน้าเตือนจน OAuth callback พัง — ข้ามสำหรับ path callback
app.use((req, res, next) => {
  if (String(req.path || "").includes("/callback")) {
    res.setHeader("ngrok-skip-browser-warning", "1");
    req.headers["ngrok-skip-browser-warning"] = "1";
  }
  next();
});

app.get("/", (req, res) => {
  res.json({
    message: "PASS Marketplace Backend",
    status: "running",
  });
});

app.get("/api/health", async (req, res) => {
  const done = startTimer("GET /api/health");
  const db = startTimer("GET /api/health database");
  let dbOk = false;
  try {
    const pool = await poolPromise;
    await pool.request().query("SELECT 1 AS ok");
    dbOk = true;
  } catch (error) {
    console.error("Health database check failed:", error.message);
  }
  const dbMs = db(dbOk ? "ok" : "error");
  const totalMs = done();
  res.status(dbOk ? 200 : 503).json({
    message: "PASS Marketplace Backend",
    status: dbOk ? "running" : "degraded",
    dbOk,
    dbMs,
    totalMs,
  });
});

app.use("/api/auth", authRoutes);
app.use("/api/settings", settingsRoutes);
app.use("/api/users", usersRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/connections", connectionRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/products", productRoutes);
app.use("/api/inventory", inventoryRoutes);
app.use("/api/stocks", inventoryRoutes);
app.use("/api/warehouses", inventoryRoutes);
app.use("/api/stock-transfers", stockTransferRoutes);
app.use("/api/inventory/transfers", stockTransferRoutes);
app.use("/api/transfers", stockTransferRoutes);
app.use("/api/sync", syncRoutes);
app.use("/api/tiktok", tiktokRoutes);
app.use("/api/lazada", lazadaRoutes);

ensureSchema().catch((error) => {
  console.error("Schema ensure failed:", error.message);
});



const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(
    "OAuth ready:",
    [
      shopeeService.isConfigured() ? "Shopee" : null,
      tiktokService.isConfigured() ? "TikTok" : null,
      lazadaService.isConfigured() ? "Lazada" : null,
    ]
      .filter(Boolean)
      .join(", ") || "none"
  );
  startTokenRefreshJob();
  startOrderSyncJob();
  startSapMapJob();
});
