const express = require("express");
const router = express.Router();

const { poolPromise } = require("../config/database");
const { normalizePlatform } = require("../utils/platform");
const { publicError } = require("../utils/normalize");
const { enqueueSync, getSyncJob } = require("../services/sync/orderSyncJob");
const { startTimer } = require("../utils/timing");

function cleanLogMessage(value) {
  let text = String(value || "")
    .replace(/^\[ซ้ำ\s*x\d+\]\s*/i, "")
    .replace(/\s*—\s*แก้ที่ Shopee IP Whitelist.*$/i, "")
    .replace(/^(Incremental|Full) Sync:\s*/i, "")
    .trim();

  const lower = text.toLowerCase();
  if (
    lower.includes("whitelist") ||
    lower.includes("undeclared") ||
    (lower.includes("ip") && lower.includes("request source"))
  ) {
    return "IP ไม่อยู่ใน Whitelist";
  }
  if (lower.includes("frequency exceeds") || lower.includes("rate limit")) {
    return "เรียก API บ่อยเกินไป (Rate limit)";
  }
  return text;
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

    const result = await pool.request().query(`
      SELECT TOP 200
        s.Id,
        s.ConnectionId,
        s.Platform,
        s.SyncType AS Action,
        s.StartTime AS Time,
        s.EndTime,
        s.Status,
        s.Message,
        s.ErrorMessage,
        s.OrderCount,
        s.ProductCount,
        s.MarketplaceOrderId,
        s.MarketplaceOrderId AS OrderNo,
        s.SapDocNum,
        s.SapDocEntry,
        s.SyncRunId,
        s.ParentSyncRunId
      FROM dbo.SyncLog AS s
      WHERE (
          s.MarketplaceOrderId IS NOT NULL
          AND LOWER(s.Status) IN (N'error', N'failed')
        )
        OR (
          s.MarketplaceOrderId IS NULL
          AND s.ParentSyncRunId IS NULL
          AND LOWER(s.Status) IN (N'error', N'failed', N'partial')
          AND NOT EXISTS (
            SELECT 1
            FROM dbo.SyncLog AS d
            WHERE d.ParentSyncRunId = s.SyncRunId
              AND d.MarketplaceOrderId IS NOT NULL
              AND LOWER(d.Status) IN (N'error', N'failed')
          )
        )
      ORDER BY s.StartTime DESC, s.Id DESC
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

function wantsIncremental(req) {
  return (
    String(req.query.incremental || "").trim() === "1" ||
    req.body?.incremental === true ||
    String(req.body?.incremental || "").trim() === "1"
  );
}

function wantsForce(req) {
  return (
    String(req.query.force || "").trim() === "1" ||
    req.body?.force === true ||
    String(req.body?.force || "").trim() === "1"
  );
}

function wantsForceProducts(req) {
  if (wantsIncremental(req) && !wantsForce(req)) return false;
  return (
    wantsForce(req) ||
    String(req.query.forceProducts || "").trim() === "1" ||
    req.body?.forceProducts === true ||
    String(req.body?.forceProducts || "").trim() === "1"
  );
}

router.get("/jobs/:jobId", (req, res) => {
  const job = getSyncJob(req.params.jobId);
  if (!job) {
    return res.status(404).json({ message: "ไม่พบงานซิงก์" });
  }
  res.json(job);
});

router.post("/now", (req, res) => {
  const done = startTimer("POST /api/sync/now");
  const job = enqueueSync({
    force: wantsForce(req),
    forceProducts: wantsForceProducts(req),
    skipCooldown: true,
  });
  done(`job=${job.jobId} ${job.status}`);
  res.status(202).json({
    success: true,
    ...job,
  });
});

router.post("/all", (req, res) => {
  const job = enqueueSync({
    force: wantsForce(req),
    forceProducts: wantsForceProducts(req),
    skipCooldown: true,
  });
  res.status(202).json({
    success: true,
    ...job,
  });
});

router.post("/:platform", (req, res) => {
  const platform = normalizePlatform(req.params.platform);

  try {
    const job = enqueueSync({
      platform,
      force: wantsForce(req),
      forceProducts: wantsForceProducts(req),
    });
    res.status(202).json({
      success: true,
      platform,
      ...job,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      message: publicError(error, "ซิงก์ไม่สำเร็จ"),
    });
  }
});

module.exports = router;
