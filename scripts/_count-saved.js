require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const { poolPromise } = require("../config/database");

(async () => {
  const pool = await poolPromise;
  const orders = await pool.request().query(`
    SELECT Platform, ShopId, COUNT(*) AS n, MIN(OrderDate) AS oldest, MAX(OrderDate) AS newest
    FROM dbo.MarketplaceOrder
    GROUP BY Platform, ShopId
    ORDER BY Platform, ShopId
  `);
  const products = await pool.request().query(`
    SELECT Platform, ShopId, COUNT(*) AS n
    FROM dbo.MarketplaceProduct
    GROUP BY Platform, ShopId
    ORDER BY Platform, ShopId
  `);
  const shops = await pool.request().query(`
    SELECT Platform, ShopName, ShopId, ConnectionStatus, LastSyncAt
    FROM dbo.MarketplaceConnection
    ORDER BY Platform, ShopName
  `);
  console.log("ORDERS");
  for (const row of orders.recordset) {
    console.log([row.Platform, row.ShopId, row.n, row.oldest, row.newest].join(" | "));
  }
  console.log("PRODUCTS");
  for (const row of products.recordset) {
    console.log([row.Platform, row.ShopId, row.n].join(" | "));
  }
  console.log("SHOPS");
  for (const row of shops.recordset) {
    console.log([row.Platform, row.ShopName, row.ShopId, row.ConnectionStatus, row.LastSyncAt].join(" | "));
  }
  process.exit(0);
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
