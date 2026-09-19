const express = require("express");
const router = express.Router();

const { poolPromise } = require("../config/database");
const { normalizePlatform } = require("../utils/platform");
const { publicError } = require("../utils/normalize");
const syncEngine = require("../services/sync/syncEngine");
const { syncAllConnected } = require("../services/sync/orderSyncJob");

function cleanLogMessage(value) {
  return String(value || "")
    .replace(/^\[ซ้ำ\s*x\d+\]\s*/i, "")
    .replace(/\s*—\s*แก้ที่ Shopee IP Whitelist.*$/i, "")
    .trim();
}

/** SQL DATETIME ไม่มี TZ — driver มักใส่ค่านาฬิกาไทยลง UTC แล้ว JSON ติด Z ทำให้หน้าเว็บ +7 */
function sqlDateTimePayload(value) {
  if (value == null || value === "") return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  const p = (n) => String(n).padStart(2, "0");
  const y = d.getUTCFullYear();
  const m = p(d.getUTCMonth() + 1);
  const day = p(d.getUTCDate());
  const h = p(d.getUTCHours());
  const min = p(d.getUTCMinutes());
  const s = p(d.getUTCSeconds());
  return `${y}-${m}-${day}T${h}:${min}:${s}+07:00`;
}

router.get("/logs", async (req, res) => {
  try {
    const pool = await poolPromise;
    const syncLogStore = require("../services/stores/syncLogStore");
    await syncLogStore.backfillFromOrders();

    const result = await pool.request().query(`
      SELECT TOP 200
        Id,
        ConnectionId,
        Platform,
        SyncType AS Action,
        StartTime AS Time,
        EndTime,
        Status,
        Message,
        ErrorMessage,
        OrderCount,
        ProductCount,
        MarketplaceOrderId,
        MarketplaceOrderId AS OrderNo,
        SapDocNum,
        SapDocEntry
      FROM SyncLog
      WHERE MarketplaceOrderId IS NOT NULL
         OR Status = N'error'
         OR ISNULL(ProductCount, 0) > 0
         OR ISNULL(OrderCount, 0) > 0
      ORDER BY StartTime DESC, Id DESC
    `);

    res.json(
      result.recordset.map((row) => ({
        ...row,
        Time: sqlDateTimePayload(row.Time),
        EndTime: sqlDateTimePayload(row.EndTime),
        Message: cleanLogMessage(row.Message),
        ErrorMessage: cleanLogMessage(row.ErrorMessage),
      }))
    );
  } catch (error) {
    console.error(error);

    res.status(500).json({
      message: "ไม่สามารถดึง Sync Log ได้",
    });
  }
});

router.post("/now", async (req, res) => {
  try {
    const force =
      String(req.query.force || req.body?.force || "").trim() === "1" ||
      req.body?.force === true;
    // Sync Now always reloads products (Shopee skips product fetch on incremental otherwise)
    const forceProducts =
      force ||
      String(req.query.forceProducts || req.body?.forceProducts || "1").trim() === "1" ||
      req.body?.forceProducts === true;
    const summary = await syncAllConnected({ force, forceProducts });
    res.json({
      success: true,
      message: summary.skipped
        ? summary.message || "ข้ามเพราะเพิ่ง sync"
        : "Sync Now เสร็จแล้ว",
      ...summary,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      message: publicError(error, "Sync Now ไม่สำเร็จ"),
    });
  }
});

router.post("/all", async (req, res) => {
  try {
    const summary = await syncAllConnected();
    res.json({
      success: true,
      message: "ซิงก์ทุกแพลตฟอร์มเสร็จแล้ว",
      ...summary,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      message: publicError(error, "ซิงก์ไม่สำเร็จ"),
    });
  }
});

router.post("/:platform", async (req, res) => {
  const platform = normalizePlatform(req.params.platform);

  try {
    const forceProducts =
      String(req.query.forceProducts || req.body?.forceProducts || "").trim() === "1" ||
      req.body?.forceProducts === true ||
      String(req.query.force || req.body?.force || "").trim() === "1" ||
      req.body?.force === true;
    const result = await syncEngine.syncPlatform(platform, { forceProducts });
    res.json(result);
  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      message: publicError(error, "ซิงก์ไม่สำเร็จ"),
    });
  }
});

module.exports = router;
