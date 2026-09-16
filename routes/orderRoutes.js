const express = require("express");
const router = express.Router();

const { poolPromise } = require("../config/database");
const { normalizePlatform } = require("../utils/platform");
const { ensureSchema } = require("../services/schema");

function parseLines(raw) {
  if (!raw) {
    return [];
  }

  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

router.get("/", async (req, res) => {
  try {
    const platform = normalizePlatform(req.query.platform);
    await ensureSchema();
    const pool = await poolPromise;
    const request = pool.request();

    let query = `
      SELECT
        Id,
        Platform,
        MarketplaceOrderId,
        CustomerName,
        CustomerPhone,
        ShippingAddress,
        OrderDate,
        OrderStatus,
        PaymentMethod,
        ShippingMethod,
        TotalAmount,
        Currency,
        SyncStatus,
        SapDocNum,
        ItemsJson
      FROM dbo.MarketplaceOrder
    `;

    if (platform) {
      request.input("platform", platform);
      query += " WHERE Platform = @platform";
    }

    query += " ORDER BY OrderDate DESC";

    const result = await request.query(query);

    res.json(
      result.recordset.map((order) => {
        const { ItemsJson, ...rest } = order;
        return {
          ...rest,
          lines: parseLines(ItemsJson),
        };
      })
    );
  } catch (error) {
    console.error(error);

    res.status(500).json({
      message: "ไม่สามารถดึง Order ได้",
    });
  }
});

module.exports = router;
