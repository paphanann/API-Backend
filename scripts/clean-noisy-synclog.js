require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const { poolPromise } = require("../config/database");
const { resolveSyncWindow } = require("../utils/syncWindow");

async function main() {
  console.log("LAZADA_FMT", resolveSyncWindow({ lastSyncAt: new Date() }).sinceLazada);

  const pool = await poolPromise;
  const del = await pool.request().query(`
    DELETE FROM dbo.SyncLog
    WHERE
      (Status = N'error' AND (Message LIKE N'%Invalid Date Format%' OR ErrorMessage LIKE N'%Invalid Date Format%'))
      OR (SyncType = N'incremental' AND ISNULL(OrderCount,0)=0 AND ISNULL(ProductCount,0)=0 AND Status IN (N'success', N'partial'))
      OR (Message LIKE N'%ออเดอร์ 0%' AND Message LIKE N'%สินค้า 0%' AND ISNULL(OrderCount,0)=0 AND ISNULL(ProductCount,0)=0)
  `);

  console.log("DELETED", del.rowsAffected);
  const left = await pool.request().query("SELECT COUNT(*) AS Cnt FROM dbo.SyncLog");
  console.log("REMAINING", left.recordset[0].Cnt);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
