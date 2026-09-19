const { poolPromise } = require("../../config/database");
const { ensureSchema } = require("./schema");

function linesJson(order) {
  const lines = Array.isArray(order.lines) ? order.lines : [];
  return JSON.stringify(lines);
}

async function upsertOrder(order) {
  await ensureSchema();
  const pool = await poolPromise;
  const items = linesJson(order);

  await pool
    .request()
    .input("platform", order.platform)
    .input("orderId", String(order.marketplaceOrderId))
    .input("customerName", order.customerName || null)
    .input("customerPhone", order.customerPhone || null)
    .input("shippingAddress", order.shippingAddress || null)
    .input("orderDate", order.orderDate || null)
    .input("orderStatus", order.orderStatus || null)
    .input("paymentMethod", order.paymentMethod || null)
    .input("shippingMethod", order.shippingMethod || null)
    .input("totalAmount", order.totalAmount)
    .input("currency", order.currency || null)
    .input("syncStatus", order.syncStatus || "saved")
    .input("itemsJson", items)
    .query(`
      IF EXISTS (
        SELECT 1
        FROM dbo.MarketplaceOrder
        WHERE Platform = @platform
          AND MarketplaceOrderId = @orderId
      )
      BEGIN
        UPDATE dbo.MarketplaceOrder
        SET
          CustomerName = @customerName,
          CustomerPhone = @customerPhone,
          ShippingAddress = @shippingAddress,
          OrderDate = @orderDate,
          OrderStatus = @orderStatus,
          PaymentMethod = @paymentMethod,
          ShippingMethod = @shippingMethod,
          TotalAmount = @totalAmount,
          Currency = @currency,
          SyncStatus = @syncStatus,
          ItemsJson = @itemsJson
        WHERE Platform = @platform
          AND MarketplaceOrderId = @orderId
      END
      ELSE
      BEGIN
        INSERT INTO dbo.MarketplaceOrder
        (
          Platform,
          MarketplaceOrderId,
          CustomerName,
          CustomerPhone,
          ShippingAddress,
          OrderDate,
          OrderStatus,
          PaymentMethod,
          ShippingMethod,
          TotalAmount,
          Currency,
          SyncStatus,
          ItemsJson
        )
        VALUES
        (
          @platform,
          @orderId,
          @customerName,
          @customerPhone,
          @shippingAddress,
          @orderDate,
          @orderStatus,
          @paymentMethod,
          @shippingMethod,
          @totalAmount,
          @currency,
          @syncStatus,
          @itemsJson
        )
      END
    `);
}

async function setSapDoc(platform, marketplaceOrderId, sapDocNum, syncStatus) {
  const pool = await poolPromise;

  await pool
    .request()
    .input("platform", platform)
    .input("orderId", String(marketplaceOrderId))
    .input("sapDocNum", sapDocNum || null)
    .input("syncStatus", syncStatus || "sap_ok")
    .query(`
      UPDATE dbo.MarketplaceOrder
      SET SapDocNum = @sapDocNum, SyncStatus = @syncStatus
      WHERE Platform = @platform
        AND MarketplaceOrderId = @orderId
    `);
}

function parseLines(raw) {
  if (!raw) {
    return [];
  }

  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function listOrders(platform) {
  await ensureSchema();
  const pool = await poolPromise;
  const request = pool.request();

  let query = `
    SELECT
      Id,
      Platform,
      MarketplaceOrderId,
      CustomerName,
      CustomerPhone,
      ShippingAddress,
      OrderDate,
      OrderStatus,
      PaymentMethod,
      ShippingMethod,
      TotalAmount,
      Currency,
      SyncStatus,
      SapDocNum,
      ItemsJson
    FROM dbo.MarketplaceOrder
  `;

  if (platform) {
    request.input("platform", platform);
    query += " WHERE Platform = @platform";
  }

  query += " ORDER BY OrderDate DESC";

  const result = await request.query(query);
  return result.recordset.map((order) => {
    const { ItemsJson, ...rest } = order;
    return {
      ...rest,
      lines: parseLines(ItemsJson),
    };
  });
}

module.exports = {
  upsertOrder,
  setSapDoc,
  listOrders,
};

