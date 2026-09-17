require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const { poolPromise } = require("../config/database");

async function main() {
  const pool = await poolPromise;

  const dupOrders = await pool.request().query(`
    SELECT Platform, MarketplaceOrderId, COUNT(*) AS Cnt
    FROM dbo.MarketplaceOrder
    GROUP BY Platform, MarketplaceOrderId
    HAVING COUNT(*) > 1
  `);

  const dupProducts = await pool.request().query(`
    SELECT Platform, ProductId, COUNT(*) AS Cnt
    FROM dbo.MarketplaceProduct
    GROUP BY Platform, ProductId
    HAVING COUNT(*) > 1
  `);

  const orderCounts = await pool.request().query(`
    SELECT Platform, COUNT(*) AS Cnt FROM dbo.MarketplaceOrder GROUP BY Platform
  `);

  const logs = await pool.request().query(`
    SELECT TOP 25 Id, Platform, SyncType, OrderCount, ProductCount, Message, StartTime
    FROM dbo.SyncLog
    ORDER BY StartTime DESC, Id DESC
  `);

  console.log("DUPLICATE_ORDERS", JSON.stringify(dupOrders.recordset));
  console.log("DUPLICATE_PRODUCTS", JSON.stringify(dupProducts.recordset));
  console.log("ORDER_COUNTS", JSON.stringify(orderCounts.recordset));
  console.log("RECENT_LOGS");
  for (const r of logs.recordset) {
    console.log(
      String(r.StartTime),
      r.Platform,
      r.SyncType,
      "o=" + r.OrderCount,
      "p=" + r.ProductCount,
      String(r.Message || "").slice(0, 70)
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
