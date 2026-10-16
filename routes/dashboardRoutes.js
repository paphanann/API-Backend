const express = require("express");
const router = express.Router();

const { poolPromise } = require("../config/database");
const { currentCompanyId } = require("../services/stores/companyContext");
const { startTimer } = require("../utils/timing");

router.get("/", async (req, res) => {
  const done = startTimer("GET /api/dashboard");
  try {
    const pool = await poolPromise;
    const db = startTimer("GET /api/dashboard database");
    const result = await pool.request()
      .input("companyId", await currentCompanyId())
      .query(`
      DECLARE @today date = CAST(DATEADD(HOUR, 7, GETUTCDATE()) AS date);

      SELECT
        CAST(DATEADD(HOUR, 7, o.OrderDate) AS date) AS DayLocal,
        o.Platform,
        COUNT(*) AS OrderCount
      FROM dbo.MarketplaceOrder o
      INNER JOIN dbo.MarketplaceConnection c
        ON c.Platform = o.Platform
       AND ISNULL(c.CompanyId, N'') = ISNULL(o.CompanyId, N'')
       AND ISNULL(c.ShopId, N'') = ISNULL(o.ShopId, N'')
       AND UPPER(c.ConnectionStatus) = N'CONNECTED'
      WHERE ISNULL(o.CompanyId, N'') = ISNULL(@companyId, N'')
        AND o.OrderDate IS NOT NULL
        AND CAST(DATEADD(HOUR, 7, o.OrderDate) AS date) >= DATEADD(DAY, -6, @today)
        AND CAST(DATEADD(HOUR, 7, o.OrderDate) AS date) <= @today
      GROUP BY CAST(DATEADD(HOUR, 7, o.OrderDate) AS date), o.Platform;

      SELECT
        LOWER(ISNULL(o.OrderStatus, N'')) AS OrderStatus,
        COUNT(*) AS OrderCount
      FROM dbo.MarketplaceOrder o
      INNER JOIN dbo.MarketplaceConnection c
        ON c.Platform = o.Platform
       AND ISNULL(c.CompanyId, N'') = ISNULL(o.CompanyId, N'')
       AND ISNULL(c.ShopId, N'') = ISNULL(o.ShopId, N'')
       AND UPPER(c.ConnectionStatus) = N'CONNECTED'
      WHERE ISNULL(o.CompanyId, N'') = ISNULL(@companyId, N'')
      GROUP BY LOWER(ISNULL(o.OrderStatus, N''));

      SELECT COUNT(*) AS Connected
      FROM dbo.MarketplaceConnection
      WHERE ISNULL(CompanyId, N'') = ISNULL(@companyId, N'')
        AND UPPER(ConnectionStatus) = N'CONNECTED';
    `);
    const dbMs = db();

    const days = [];
    const today = new Date();
    const bangkok = new Date(today.getTime() + 7 * 60 * 60 * 1000);
    for (let i = 6; i >= 0; i -= 1) {
      const day = new Date(Date.UTC(bangkok.getUTCFullYear(), bangkok.getUTCMonth(), bangkok.getUTCDate()));
      day.setUTCDate(day.getUTCDate() - i);
      days.push(day.toISOString().slice(0, 10));
    }

    const byDay = new Map();
    for (const row of result.recordsets[0] || []) {
      const key = row.DayLocal instanceof Date
        ? row.DayLocal.toISOString().slice(0, 10)
        : String(row.DayLocal).slice(0, 10);
      const platform = String(row.Platform || "").toLowerCase();
      if (!byDay.has(key)) byDay.set(key, {});
      byDay.get(key)[platform] = Number(row.OrderCount) || 0;
    }

    const week = (name) => days.map((day) => (byDay.get(day) && byDay.get(day)[name]) || 0);
    const shopeeWeek = week("shopee");
    const tiktokWeek = week("tiktok");
    const lazadaWeek = week("lazada");

    let pendingOrders = 0;
    let successOrders = 0;
    let totalOrders = 0;
    let shopeeTotal = 0;
    let tiktokTotal = 0;
    let lazadaTotal = 0;
    for (const row of result.recordsets[1] || []) {
      const count = Number(row.OrderCount) || 0;
      totalOrders += count;
      const status = String(row.OrderStatus || "");
      if (status.includes("cancel")) continue;
      if (status.includes("success") || status.includes("complete") || status.includes("deliver")) {
        successOrders += count;
      } else {
        pendingOrders += count;
      }
    }
    shopeeTotal = shopeeWeek.reduce((sum, n) => sum + n, 0);
    tiktokTotal = tiktokWeek.reduce((sum, n) => sum + n, 0);
    lazadaTotal = lazadaWeek.reduce((sum, n) => sum + n, 0);
    const weekTotal = shopeeTotal + tiktokTotal + lazadaTotal;
    const share = (n) => (weekTotal === 0 ? 0 : Math.round((n * 1000) / weekTotal) / 10);

    const payload = {
      totalOrders,
      pendingOrders,
      successOrders,
      connected: Number(result.recordsets[2] && result.recordsets[2][0] && result.recordsets[2][0].Connected) || 0,
      weekLabels: days.map((day) => {
        const [, m, d] = day.split("-");
        return `${Number(d)}/${Number(m)}`;
      }),
      shopeeWeek,
      tiktokWeek,
      lazadaWeek,
      shopeeShare: share(shopeeTotal),
      tiktokShare: share(tiktokTotal),
      lazadaShare: share(lazadaTotal),
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
