const { poolPromise } = require("../../config/database");
const { ensureSchema } = require("./schema");
const { errorFingerprint } = require("../../utils/syncErrors");

const DEDUPE_HOURS = Number(process.env.SYNC_ERROR_DEDUPE_HOURS || 12);

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
}) {
  await ensureSchema();
  const pool = await poolPromise;

  const statusNorm = String(status || "").toLowerCase();
  const errText = errorMessage || message || "";

  // Error ซ้ำ (เช่น IP whitelist) — อัปเดตแถวล่าสุดแทน INSERT
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
        // อัปเดตเวลาอย่างเดียว — ไม่ใส่ [ซ้ำ xN] ในข้อความที่โชว์
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
    .query(`
      INSERT INTO dbo.SyncLog
      (
        ConnectionId, Platform, SyncType, StartTime, EndTime, Status,
        Message, ErrorMessage, OrderCount, ProductCount,
        MarketplaceOrderId, SapDocNum, SapDocEntry
      )
      VALUES
      (
        @connectionId, @platform, @syncType, GETDATE(), GETDATE(), @status,
        @message, @errorMessage, @orderCount, @productCount,
        @marketplaceOrderId, @sapDocNum, @sapDocEntry
      )
    `);

  return { deduped: false };
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

async function backfillFromOrders() {
  await ensureSchema();
  const pool = await poolPromise;

  await pool.request().query(`
    INSERT INTO dbo.SyncLog
    (
      ConnectionId, Platform, SyncType, StartTime, EndTime, Status,
      Message, OrderCount, ProductCount, MarketplaceOrderId, SapDocNum
    )
    SELECT
      c.ConnectionId,
      o.Platform,
      N'order',
      COALESCE(o.OrderDate, GETDATE()),
      COALESCE(o.OrderDate, GETDATE()),
      N'success',
      N'ออเดอร์ ' + o.MarketplaceOrderId,
      1,
      0,
      o.MarketplaceOrderId,
      o.SapDocNum
    FROM dbo.MarketplaceOrder AS o
    OUTER APPLY (
      SELECT TOP 1 ConnectionId
      FROM dbo.MarketplaceConnection AS mc
      WHERE mc.Platform = o.Platform
      ORDER BY mc.UpdatedAt DESC
    ) AS c
    WHERE NOT EXISTS (
      SELECT 1
      FROM dbo.SyncLog AS s
      WHERE s.Platform = o.Platform
        AND s.MarketplaceOrderId = o.MarketplaceOrderId
    )
  `);
}

module.exports = {
  writeLog,
  backfillFromOrders,
  collapseDuplicateErrors,
};
