const { poolPromise } = require("../config/database");
const { ensureSchema } = require("./schema");

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
        ConnectionId,
        Platform,
        SyncType,
        StartTime,
        EndTime,
        Status,
        Message,
        ErrorMessage,
        OrderCount,
        ProductCount,
        MarketplaceOrderId,
        SapDocNum,
        SapDocEntry
      )
      VALUES
      (
        @connectionId,
        @platform,
        @syncType,
        GETDATE(),
        GETDATE(),
        @status,
        @message,
        @errorMessage,
        @orderCount,
        @productCount,
        @marketplaceOrderId,
        @sapDocNum,
        @sapDocEntry
      )
    `);
}

/** สร้าง Sync Log จากออเดอร์ที่มีอยู่แล้ว ถ้ายังไม่มีแถวเลขนั้น */
async function backfillFromOrders() {
  await ensureSchema();
  const pool = await poolPromise;

  await pool.request().query(`
    INSERT INTO dbo.SyncLog
    (
      ConnectionId,
      Platform,
      SyncType,
      StartTime,
      EndTime,
      Status,
      Message,
      OrderCount,
      ProductCount,
      MarketplaceOrderId,
      SapDocNum
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
};
