require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const { poolPromise } = require("../config/database");

/** เหลือแค่ log ล่าสุดต่อแพลตฟอร์ม — เคลียร์ประวัติที่ซ้ำจากช่วง sync ถี่ */
async function main() {
  const pool = await poolPromise;
  const del = await pool.request().query(`
    ;WITH ranked AS (
      SELECT Id,
             ROW_NUMBER() OVER (PARTITION BY Platform ORDER BY StartTime DESC, Id DESC) AS rn
      FROM dbo.SyncLog
    )
    DELETE FROM ranked WHERE rn > 1
  `);
  console.log("DELETED_DUPES", del.rowsAffected);
  const left = await pool.request().query(`
    SELECT Id, Platform, SyncType, Status, OrderCount, ProductCount, Message, StartTime
    FROM dbo.SyncLog
    ORDER BY StartTime DESC
  `);
  console.log("LEFT", JSON.stringify(left.recordset, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
