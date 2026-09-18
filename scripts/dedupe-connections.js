require("dotenv").config();
const { poolPromise } = require("../config/database");

async function main() {
  const pool = await poolPromise;

  const before = await pool.request().query(`
    SELECT ConnectionId, Platform, ShopId, ShopName,
           CASE WHEN AccessToken IS NULL OR LEN(AccessToken)=0 THEN 0 ELSE 1 END AS HasToken,
           ConnectionStatus
    FROM dbo.MarketplaceConnection
    ORDER BY Platform, ConnectionId
  `);
  console.log("BEFORE", JSON.stringify(before.recordset, null, 2));

  const del = await pool.request().query(`
    ;WITH ranked AS (
      SELECT
        ConnectionId,
        ROW_NUMBER() OVER (
          PARTITION BY Platform
          ORDER BY UpdatedAt DESC, ConnectionId DESC
        ) AS rn
      FROM dbo.MarketplaceConnection
    )
    DELETE FROM ranked WHERE rn > 1;
  `);
  console.log("DELETED", del.rowsAffected);

  try {
    await pool.request().query(`
      IF NOT EXISTS (
        SELECT 1 FROM sys.indexes
        WHERE name = N'UX_MarketplaceConnection_Platform'
          AND object_id = OBJECT_ID(N'dbo.MarketplaceConnection')
      )
      CREATE UNIQUE INDEX UX_MarketplaceConnection_Platform
        ON dbo.MarketplaceConnection (Platform);
    `);
    console.log("UNIQUE_INDEX ok");
  } catch (e) {
    console.log("UNIQUE_INDEX", e.message);
  }

  const after = await pool.request().query(`
    SELECT ConnectionId, Platform, ShopId, ShopName,
           CASE WHEN AccessToken IS NULL OR LEN(AccessToken)=0 THEN 0 ELSE 1 END AS HasToken,
           ConnectionStatus
    FROM dbo.MarketplaceConnection
    ORDER BY Platform, ConnectionId
  `);
  console.log("AFTER", JSON.stringify(after.recordset, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
