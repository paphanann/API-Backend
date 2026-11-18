const express = require("express");
const router = express.Router();

let indexReady = false;

async function ensureOrderDateIndex(pool) {
  if (indexReady) return;
  try {
  await pool.request().query(`
    IF OBJECT_ID(N'dbo.MarketplaceOrder', N'U') IS NOT NULL
       AND COL_LENGTH('dbo.MarketplaceOrder', 'CompanyId') IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM sys.indexes
         WHERE name = N'IX_MarketplaceOrder_Company_OrderDate'
           AND object_id = OBJECT_ID(N'dbo.MarketplaceOrder')
       )
      CREATE INDEX IX_MarketplaceOrder_Company_OrderDate
        ON dbo.MarketplaceOrder (CompanyId, OrderDate DESC)
        INCLUDE (Platform, ShopId, OrderStatus, SapDocNum, DeliveryDocNum, TotalAmount, MarketplaceOrderId)
  `);
    indexReady = true;
  } catch (error) {
    console.error(error);
    indexReady = true;
  }
}

const { poolPromise, sql } = require("../config/database");
const { currentCompanyId } = require("../services/stores/companyContext");
const { startTimer } = require("../utils/timing");
const { normalizePlatform } = require("../utils/platform");

function wallClock(value) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return value;
  const pad = (n) => String(n).padStart(2, "0");
  return `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}T${pad(value.getUTCHours())}:${pad(value.getUTCMinutes())}:${pad(value.getUTCSeconds())}`;
}

function bangkokDay(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || "").trim());
  if (!match) return null;
  const y = Number(match[1]);
  const mo = Number(match[2]);
  const d = Number(match[3]);
  if (!y || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return { y, mo, d };
}

function shiftDay(day, delta) {
  const dt = new Date(Date.UTC(day.y, day.mo - 1, day.d + delta));
  return { y: dt.getUTCFullYear(), mo: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

function utcStart(day) {
  return new Date(Date.UTC(day.y, day.mo - 1, day.d, 0, 0, 0));
}

function dayKey(day) {
  return `${day.y}-${String(day.mo).padStart(2, "0")}-${String(day.d).padStart(2, "0")}`;
}

router.get("/", async (req, res) => {
  const done = startTimer("GET /api/dashboard");
  try {
    const pool = await poolPromise;
    const companyId = await currentCompanyId();

    const filters = [];
    const platforms = [
      ...new Set(
        String(req.query.platform || "")
          .split(",")
          .map((item) => normalizePlatform(item.trim()))
          .filter(Boolean)
      ),
    ];
    const shopIds = [
      ...new Set(
        String(req.query.shopId || "")
          .split(",")
          .map((item) => item.trim())
          .filter((item) => item && item !== "all" && item !== "-")
      ),
    ];
    const platformParams = platforms.map((_, index) => (platforms.length === 1 ? "platform" : `platform${index}`));
    const shopParams = shopIds.map((_, index) => (shopIds.length === 1 ? "shopId" : `shopId${index}`));
    if (platforms.length === 1) filters.push("o.Platform = @platform");
    else if (platforms.length > 1) filters.push(`o.Platform IN (${platformParams.map((name) => `@${name}`).join(", ")})`);
    if (shopIds.length === 1) filters.push("(o.ShopId = @shopId OR o.ShopName = @shopId)");
    else if (shopIds.length > 1) {
      filters.push(`(${shopParams.map((name) => `(o.ShopId = @${name} OR o.ShopName = @${name})`).join(" OR ")})`);
    }
    const productPlatform = platforms.length
      ? `AND p.Platform ${platforms.length === 1 ? "= @platform" : `IN (${platformParams.map((name) => `@${name}`).join(", ")})`}`
      : "";
    const productShop = shopIds.length
      ? shopIds.length === 1
        ? "AND p.ShopId = @shopId"
        : `AND (${shopParams.map((name) => `p.ShopId = @${name}`).join(" OR ")})`
      : "";

    const nowBangkok = new Date(Date.now() + 7 * 60 * 60 * 1000);
    const today = { y: nowBangkok.getUTCFullYear(), mo: nowBangkok.getUTCMonth() + 1, d: nowBangkok.getUTCDate() };
    const toDay = bangkokDay(req.query.to) || today;
    const fromDay = bangkokDay(req.query.from);
    if (fromDay) {
      filters.push("o.OrderDate >= @fromDate AND o.OrderDate < @toDate");
    }

    const weekStart = shiftDay(toDay, -6);
    const weekFrom = fromDay && utcStart(weekStart) < utcStart(fromDay) ? fromDay : weekStart;
    const where = filters.length ? `AND ${filters.join(" AND ")}` : "";
    const active = "LOWER(ISNULL(o.OrderStatus, N'')) NOT IN (N'cancelled', N'returned', N'canceled')";
    const scope = `
      FROM dbo.MarketplaceOrder o WITH (NOLOCK)
      WHERE o.CompanyId = @companyId
        ${where}
    `;

    await ensureOrderDateIndex(pool);
    const db = startTimer("GET /api/dashboard database");
    const countReq = pool.request();
    const weekReq = pool.request();
    const productReq = pool.request();
    const recentReq = pool.request();
    for (const q of [countReq, weekReq, productReq, recentReq]) {
      q.input("companyId", companyId);
      platforms.forEach((item, index) => q.input(platformParams[index], sql.NVarChar(40), item));
      shopIds.forEach((item, index) => q.input(shopParams[index], sql.NVarChar(100), item));
      if (fromDay) {
        q.input("fromDate", sql.DateTime2, utcStart(fromDay));
        q.input("toDate", sql.DateTime2, utcStart(shiftDay(toDay, 1)));
      } else {
        q.input("toDate", sql.DateTime2, utcStart(shiftDay(toDay, 1)));
      }
      q.input("weekFrom", sql.DateTime2, utcStart(weekFrom));
    }
    const [counts, week, products, recent] = await Promise.all([
      countReq.query(`
        SELECT
          COUNT(*) AS TotalOrders,
          SUM(CASE WHEN ${active} AND NULLIF(LTRIM(RTRIM(o.SapDocNum)), N'') IS NOT NULL THEN 1 ELSE 0 END) AS SoCount,
          SUM(CASE WHEN ${active} AND NULLIF(LTRIM(RTRIM(o.DeliveryDocNum)), N'') IS NOT NULL THEN 1 ELSE 0 END) AS DeliveryCount,
          SUM(CASE WHEN ${active} AND NULLIF(LTRIM(RTRIM(o.SapDocNum)), N'') IS NULL THEN 1 ELSE 0 END) AS WaitSo,
          SUM(CASE WHEN o.Platform = N'Shopee' THEN 1 ELSE 0 END) AS ShopeeCount,
          SUM(CASE WHEN o.Platform = N'TikTok' THEN 1 ELSE 0 END) AS TiktokCount,
          SUM(CASE WHEN o.Platform = N'Lazada' THEN 1 ELSE 0 END) AS LazadaCount
        ${scope}
      `),
      weekReq.query(`
        SELECT
          CAST(o.OrderDate AS date) AS DayLocal,
          o.Platform,
          COUNT(*) AS OrderCount
        ${scope}
          AND o.OrderDate >= @weekFrom AND o.OrderDate < @toDate
        GROUP BY CAST(o.OrderDate AS date), o.Platform
      `),
      productReq.query(`
        SELECT COUNT(*) AS ProductCount
        FROM dbo.MarketplaceProduct p WITH (NOLOCK)
        WHERE p.CompanyId = @companyId
          ${productPlatform}
          ${productShop}
      `),
      recentReq.query(`
        SELECT TOP (20)
          o.MarketplaceOrderId,
          o.Platform,
          o.CompanyId,
          o.ShopId,
          o.ShopName,
          o.OrderDate,
          o.OrderStatus,
          o.TotalAmount,
          o.SapDocNum,
          o.DeliveryDocNum
        ${scope}
        ORDER BY o.OrderDate DESC
      `),
    ]);
    const dbMs = db();

    const row = counts.recordset[0] || {};
    const totalOrders = Number(row.TotalOrders) || 0;
    const shopeeTotal = Number(row.ShopeeCount) || 0;
    const tiktokTotal = Number(row.TiktokCount) || 0;
    const lazadaTotal = Number(row.LazadaCount) || 0;
    const share = (n) => (totalOrders === 0 ? 0 : Math.round((n * 1000) / totalOrders) / 10);

    const days = [];
    for (let i = 6; i >= 0; i -= 1) days.push(shiftDay(toDay, -i));
    const byDay = new Map();
    for (const item of week.recordset) {
      const key = item.DayLocal instanceof Date
        ? item.DayLocal.toISOString().slice(0, 10)
        : String(item.DayLocal).slice(0, 10);
      const name = String(item.Platform || "").toLowerCase();
      if (!byDay.has(key)) byDay.set(key, {});
      const bucket = name.includes("tiktok") ? "tiktok" : name.includes("lazada") ? "lazada" : name.includes("shopee") ? "shopee" : name;
      byDay.get(key)[bucket] = (byDay.get(key)[bucket] || 0) + (Number(item.OrderCount) || 0);
    }
    const series = (name) => days.map((day) => (byDay.get(dayKey(day)) && byDay.get(dayKey(day))[name]) || 0);

    const payload = {
      totalOrders,
      pendingOrders: Number(row.WaitSo) || 0,
      successOrders: Number(row.SoCount) || 0,
      productCount: Number(products.recordset[0] && products.recordset[0].ProductCount) || 0,
      soCount: Number(row.SoCount) || 0,
      deliveryCount: Number(row.DeliveryCount) || 0,
      waitSo: Number(row.WaitSo) || 0,
      weekLabels: days.map((day) => `${day.d}/${day.mo}`),
      shopeeWeek: series("shopee"),
      tiktokWeek: series("tiktok"),
      lazadaWeek: series("lazada"),
      shopeeShare: share(shopeeTotal),
      tiktokShare: share(tiktokTotal),
      lazadaShare: share(lazadaTotal),
      recent: (recent.recordset || []).map((order) => ({
        MarketplaceOrderId: order.MarketplaceOrderId,
        Platform: order.Platform,
        CompanyId: order.CompanyId,
        ShopId: order.ShopId,
        ShopName: order.ShopName,
        OrderDate: wallClock(order.OrderDate),
        OrderStatus: order.OrderStatus,
        TotalAmount: order.TotalAmount,
        SapDocNum: order.SapDocNum,
        DeliveryDocNum: order.DeliveryDocNum,
      })),
      dbMs,
    };
    done(`db=${dbMs}ms orders=${totalOrders}`);
    res.json(payload);
  } catch (error) {
    console.error(error);
    done("error");
    res.status(500).json({ message: "ไม่สามารถดึงแดชบอร์ดได้" });
  }
});

module.exports = router;
