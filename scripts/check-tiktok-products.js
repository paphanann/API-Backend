require("dotenv").config();
const { poolPromise } = require("../config/database");

async function main() {
  const pool = await poolPromise;

  const conn = await pool.request().query(`
    SELECT
      Platform, ShopId, ShopName, ConnectionStatus,
      CASE WHEN AccessToken IS NULL OR LEN(AccessToken)=0 THEN 0 ELSE 1 END AS HasAccess,
      CASE WHEN RefreshToken IS NULL OR LEN(RefreshToken)=0 THEN 0 ELSE 1 END AS HasRefresh,
      CASE WHEN ShopCipher IS NULL OR LEN(ShopCipher)=0 THEN 0 ELSE 1 END AS HasCipher,
      AccessTokenExpiresAt, LastSyncAt, LastRefreshAt
    FROM dbo.MarketplaceConnection
    WHERE Platform = N'TikTok'
  `);
  console.log("CONN", JSON.stringify(conn.recordset, null, 2));

  const counts = await pool.request().query(`
    SELECT Platform, COUNT(*) AS Cnt
    FROM dbo.MarketplaceProduct
    GROUP BY Platform
  `);
  console.log("PRODUCT_COUNTS", JSON.stringify(counts.recordset, null, 2));
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
