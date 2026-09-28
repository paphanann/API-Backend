const crypto = require("crypto");
const { poolPromise } = require("../../config/database");
const { ensureSchema } = require("./schema");
const { errorFingerprint } = require("../../utils/syncErrors");

const DEDUPE_HOURS = Number(process.env.SYNC_ERROR_DEDUPE_HOURS || 12);

function newSyncRunId() {
  return crypto.randomUUID();
}

/**
 * เริ่มรอบ Sync — INSERT แถวหลักครั้งเดียว (status=running)
 * สำเร็จ/ล้มเหลวใช้ finishRun() UPDATE ไม่ใช่ INSERT ซ้ำ
 */
async function beginRun({
  connectionId,
  platform,
  syncType,
  syncRunId = null,
  message = null,
}) {
  await ensureSchema();
  const pool = await poolPromise;
  const id = syncRunId || newSyncRunId();

  await pool
    .request()
    .input("connectionId", connectionId || null)
    .input("platform", platform)
    .input("syncType", syncType || "incremental")
    .input("syncRunId", id)
    .input("message", message || "กำลังซิงก์…")
    .query(`
      INSERT INTO dbo.SyncLog
      (
        ConnectionId, Platform, SyncType, StartTime, EndTime, Status,
        Message, ErrorMessage, OrderCount, ProductCount,
        MarketplaceOrderId, SapDocNum, SapDocEntry, SyncRunId, ParentSyncRunId
      )
      VALUES
      (
        @connectionId, @platform, @syncType, GETDATE(), GETDATE(), N'running',
        @message, NULL, 0, 0,
        NULL, NULL, NULL, @syncRunId, NULL
      )
    `);

  return { syncRunId: id };
}

async function finishRun(syncRunId, {
  status,
  message,
  errorMessage = null,
  orderCount = 0,
  productCount = 0,
  sapDocNum = null,
  sapDocEntry = null,
} = {}) {
  if (!syncRunId) return { updated: false };
  await ensureSchema();
  const pool = await poolPromise;

  const result = await pool
    .request()
    .input("syncRunId", syncRunId)
    .input("status", status || "success")
    .input("message", message || null)
    .input("errorMessage", errorMessage || null)
    .input("orderCount", orderCount || 0)
    .input("productCount", productCount || 0)
    .input("sapDocNum", sapDocNum ? String(sapDocNum) : null)
    .input("sapDocEntry", sapDocEntry ? String(sapDocEntry) : null)
    .query(`
      UPDATE dbo.SyncLog
      SET EndTime = GETDATE(),
          Status = @status,
          Message = @message,
          ErrorMessage = @errorMessage,
          OrderCount = @orderCount,
          ProductCount = @productCount,
          SapDocNum = COALESCE(@sapDocNum, SapDocNum),
          SapDocEntry = COALESCE(@sapDocEntry, SapDocEntry)
      WHERE SyncRunId = @syncRunId
        AND MarketplaceOrderId IS NULL
        AND ParentSyncRunId IS NULL
    `);

  return { updated: (result.rowsAffected && result.rowsAffected[0]) > 0 };
}

/** รายละเอียดออเดอร์ในรอบนั้น — ผูก ParentSyncRunId ไม่สร้างแถว Incremental ซ้ำ */
async function writeDetail({
  connectionId,
  platform,
  parentSyncRunId,
  status,
  message,
  errorMessage,
  marketplaceOrderId,
  sapDocNum,
  sapDocEntry,
}) {
  if (!marketplaceOrderId) return { skipped: true };
  await ensureSchema();
  const pool = await poolPromise;

  await pool
    .request()
    .input("connectionId", connectionId || null)
    .input("platform", platform)
    .input("status", status)
    .input("message", message || null)
    .input("errorMessage", errorMessage || null)
    .input("marketplaceOrderId", String(marketplaceOrderId))
    .input("sapDocNum", sapDocNum ? String(sapDocNum) : null)
    .input("sapDocEntry", sapDocEntry ? String(sapDocEntry) : null)
    .input("parentSyncRunId", parentSyncRunId || null)
    .query(`
      INSERT INTO dbo.SyncLog
      (
        ConnectionId, Platform, SyncType, StartTime, EndTime, Status,
        Message, ErrorMessage, OrderCount, ProductCount,
        MarketplaceOrderId, SapDocNum, SapDocEntry, SyncRunId, ParentSyncRunId
      )
      VALUES
      (
        @connectionId, @platform, N'order', GETDATE(), GETDATE(), @status,
        @message, @errorMessage, 1, 0,
        @marketplaceOrderId, @sapDocNum, @sapDocEntry, NULL, @parentSyncRunId
      )
    `);

  return { parentSyncRunId };
}

/** legacy fallback — ใช้เฉพาะ error ที่ไม่มี sync run */
async function writeLog({
  connectionId,
  platform,
  syncType,
  status,
  message,
  errorMessage,
  orderCount,
  productCount,
  marketplaceOrderId,
  sapDocNum,
  sapDocEntry,
  syncRunId,
  parentSyncRunId,
}) {
  await ensureSchema();
  const pool = await poolPromise;

  const statusNorm = String(status || "").toLowerCase();
  const errText = errorMessage || message || "";

  if (statusNorm === "error" && !marketplaceOrderId) {
    const fingerprint = errorFingerprint(errText);
    const existing = await pool
      .request()
      .input("platform", platform)
      .input("hours", DEDUPE_HOURS)
      .query(`
        SELECT TOP 1 Id, Message, ErrorMessage
        FROM dbo.SyncLog
        WHERE Platform = @platform
          AND LOWER(Status) = N'error'
          AND MarketplaceOrderId IS NULL
          AND EndTime >= DATEADD(HOUR, -@hours, GETDATE())
        ORDER BY EndTime DESC
      `);

    const row = existing.recordset && existing.recordset[0];
    if (row) {
      const prevFp = errorFingerprint(row.ErrorMessage || row.Message);
      if (prevFp && fingerprint && prevFp === fingerprint) {
        const cleanMsg = String(message || errText || row.Message || "")
          .replace(/^\[ซ้ำ\s*x\d+\]\s*/i, "")
          .replace(/\s*—\s*แก้ที่ Shopee IP Whitelist.*$/i, "")
          .trim();

        await pool
          .request()
          .input("id", row.Id)
          .input("message", cleanMsg || null)
          .input("errorMessage", errText)
          .query(`
            UPDATE dbo.SyncLog
            SET EndTime = GETDATE(),
                Message = @message,
                ErrorMessage = @errorMessage
            WHERE Id = @id
          `);

        return { deduped: true, id: row.Id };
      }
    }
  }

  const runId = syncRunId || (marketplaceOrderId ? null : newSyncRunId());

  await pool
    .request()
    .input("connectionId", connectionId || null)
    .input("platform", platform)
    .input("syncType", syncType || "orders")
    .input("status", status)
    .input("message", message || null)
    .input("errorMessage", errorMessage || null)
    .input("orderCount", orderCount || 0)
    .input("productCount", productCount || 0)
    .input("marketplaceOrderId", marketplaceOrderId ? String(marketplaceOrderId) : null)
    .input("sapDocNum", sapDocNum ? String(sapDocNum) : null)
    .input("sapDocEntry", sapDocEntry ? String(sapDocEntry) : null)
    .input("syncRunId", runId)
    .input("parentSyncRunId", parentSyncRunId || null)
    .query(`
      INSERT INTO dbo.SyncLog
      (
        ConnectionId, Platform, SyncType, StartTime, EndTime, Status,
        Message, ErrorMessage, OrderCount, ProductCount,
        MarketplaceOrderId, SapDocNum, SapDocEntry, SyncRunId, ParentSyncRunId
      )
      VALUES
      (
        @connectionId, @platform, @syncType, GETDATE(), GETDATE(), @status,
        @message, @errorMessage, @orderCount, @productCount,
        @marketplaceOrderId, @sapDocNum, @sapDocEntry, @syncRunId, @parentSyncRunId
      )
    `);

  return { deduped: false, syncRunId: runId };
}

async function collapseDuplicateErrors() {
  await ensureSchema();
  const pool = await poolPromise;
  const result = await pool.request().query(`
    ;WITH ranked AS (
      SELECT
        Id,
        ROW_NUMBER() OVER (
          PARTITION BY Platform, LEFT(LOWER(LTRIM(RTRIM(ISNULL(ErrorMessage, Message)))), 180)
          ORDER BY EndTime DESC, Id DESC
        ) AS rn
      FROM dbo.SyncLog
      WHERE LOWER(Status) = N'error'
        AND MarketplaceOrderId IS NULL
    )
    DELETE FROM ranked WHERE rn > 1;
    SELECT @@ROWCOUNT AS Deleted;
  `);
  return Number(result.recordset && result.recordset[0] && result.recordset[0].Deleted) || 0;
}

/** ลบแถวสำเร็จที่ซ้ำเป๊ะในวินาทีเดียวกัน (เคส INSERT ซ้ำในรอบเดียว) */
async function collapseDuplicateRuns() {
  await ensureSchema();
  const pool = await poolPromise;
  const result = await pool.request().query(`
    ;WITH ranked AS (
      SELECT
        Id,
        ROW_NUMBER() OVER (
          PARTITION BY
            Platform,
            SyncType,
            LOWER(Status),
            LEFT(LOWER(LTRIM(RTRIM(ISNULL(Message, N'')))), 200),
            ISNULL(OrderCount, 0),
            ISNULL(ProductCount, 0),
            CONVERT(VARCHAR(19), StartTime, 120)
          ORDER BY Id DESC
        ) AS rn
      FROM dbo.SyncLog
      WHERE MarketplaceOrderId IS NULL
        AND ParentSyncRunId IS NULL
        AND LOWER(Status) IN (N'success', N'skipped')
    )
    DELETE FROM ranked WHERE rn > 1;
    SELECT @@ROWCOUNT AS Deleted;
  `);
  return Number(result.recordset && result.recordset[0] && result.recordset[0].Deleted) || 0;
}

module.exports = {
  newSyncRunId,
  beginRun,
  finishRun,
  writeDetail,
  writeLog,
  collapseDuplicateErrors,
  collapseDuplicateRuns,
};
