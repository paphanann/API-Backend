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
        ProductCount
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
        @productCount
      )
    `);
}

module.exports = {
  writeLog,
};
