const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });



const express = require("express");
const cors = require("cors");

const connectionRoutes = require("./routes/connectionRoutes");
const orderRoutes = require("./routes/orderRoutes");
const productRoutes = require("./routes/productRoutes");
const inventoryRoutes = require("./routes/inventoryRoutes");
const syncRoutes = require("./routes/syncRoutes");
const authRoutes = require("./routes/authRoutes");
const tiktokRoutes = require("./routes/oauth/tiktokRoutes");
const lazadaRoutes = require("./routes/oauth/lazadaRoutes");
const shopeeService = require("./services/marketplaces/shopeeService");
const tiktokService = require("./services/marketplaces/tiktokService");
const lazadaService = require("./services/marketplaces/lazadaService");
const { ensureSchema } = require("./services/stores/schema");
const { startTokenRefreshJob } = require("./services/sync/tokenRefreshJob");
const { startOrderSyncJob } = require("./services/sync/orderSyncJob");

const app = express();

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

app.get("/api/health", (req, res) => {
  res.json({
    message: "PASS Marketplace Backend",
    status: "running",
  });
});

app.use("/api/auth", authRoutes);
app.use("/api/connections", connectionRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/products", productRoutes);
app.use("/api/inventory", inventoryRoutes);
app.use("/api/stocks", inventoryRoutes);
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
});
