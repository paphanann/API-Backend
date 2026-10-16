require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const { poolPromise } = require("../config/database");

(async () => {
  const pool = await poolPromise;
  const orders = await pool.request().query(`
    SELECT SyncStatus, COUNT(1) AS n,
      SUM(CASE WHEN SapDocNum IS NULL OR SapDocNum = N'' THEN 0 ELSE 1 END) AS sap,
      MIN(OrderDate) AS oldest, MAX(OrderDate) AS newest
    FROM dbo.MarketplaceOrder
    WHERE Platform = N'Shopee' AND ShopId = N'735119532'
    GROUP BY SyncStatus
  `);
  const products = await pool.request().query(`
    SELECT COUNT(1) AS n
    FROM dbo.MarketplaceProduct
    WHERE Platform = N'Shopee' AND ShopId = N'735119532'
  `);
  console.log("ORDERS", JSON.stringify(orders.recordset));
  console.log("PRODUCTS", products.recordset[0].n);
  const marked = await pool.request().query(`
    UPDATE dbo.MarketplaceOrder
    SET SyncStatus = N'history'
    WHERE Platform = N'Shopee'
      AND ShopId = N'735119532'
      AND (SapDocNum IS NULL OR SapDocNum = N'')
      AND ISNULL(SyncStatus, N'') <> N'history'
  `);
  console.log("MARKED_HISTORY", marked.rowsAffected && marked.rowsAffected[0]);
  process.exit(0);
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
