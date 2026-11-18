require("dotenv").config();

const { poolPromise } = require("../config/database");
const orderStore = require("../services/stores/orderStore");
const { resendSalesOrder } = require("../services/sync/syncEngine");

const DRY_RUN = process.argv.includes("--dry-run");

async function main() {
  const pool = await poolPromise;

  const result = await pool.request().query(`
    SELECT TOP (20)
      Id,
      Platform,
      MarketplaceOrderId,
      PlatformStatus
    FROM dbo.MarketplaceOrder
    WHERE OrderDate >= '2026-11-17'
      AND Platform IN ('Shopee', 'Lazada', 'TikTok')
      AND SyncStatus = 'saved'
      AND (SapDocNum IS NULL OR LTRIM(RTRIM(SapDocNum)) = '')
      AND (NextRetryAt IS NULL OR NextRetryAt <= GETDATE())
      AND LOWER(REPLACE(REPLACE(
        LTRIM(RTRIM(PlatformStatus)), ' ', '_'
      ), '-', '_')) IN (
        'ready_to_ship',
        'on_hold',
        'pending',
        'awaiting_shipment',
        'awaiting_collection'
      )
    ORDER BY OrderDate ASC, Id ASC
  `);

  console.log("Backfill candidates:", result.recordset.length);

  if (DRY_RUN) {
    console.table(result.recordset);
    return;
  }

  let ok = 0;
  let failed = 0;
  let skipped = 0;

  for (const item of result.recordset) {
    try {
      const rows = await orderStore.listOrders(
        item.Platform,
        String(item.MarketplaceOrderId)
      );

      const order = rows.find(
        row => Number(row.Id) === Number(item.Id)
      );

      if (!order) {
        skipped++;
        console.log("SKIP order not found:", item.Id);
        continue;
      }

      const sap = await resendSalesOrder(order);

      if (sap.status === "ok") {
        ok++;
        console.log(
          "SUCCESS",
          item.Platform,
          item.MarketplaceOrderId,
          "SO=", sap.docNum
        );
      } else if (sap.status === "error") {
        failed++;
        console.log(
          "ERROR",
          item.MarketplaceOrderId,
          sap.message
        );
      } else {
        skipped++;
        console.log("SKIPPED", item.MarketplaceOrderId);
      }
    } catch (error) {
      failed++;
      console.error(
        "FAILED",
        item.MarketplaceOrderId,
        error.message
      );
    }
  }

  console.log({ ok, failed, skipped });
}

main()
  .catch(error => {
    console.error("Backfill failed:", error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    const { sql } = require("../config/database");
    await sql.close();
  });

