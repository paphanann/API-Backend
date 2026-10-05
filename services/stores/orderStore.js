const { poolPromise } = require("../../config/database");
const { splitOrderAmounts, mapShippingStatus, mapOrderStatus } = require("../../utils/normalize");
const { ensureSchema } = require("./schema");

function linesJson(order) {
  const lines = Array.isArray(order.lines) ? order.lines : [];
  return JSON.stringify(lines);
}

function normText(value) {
  if (value == null) return "";
  return String(value).trim();
}

function bangkokStamp(value) {
  if (value == null || value === "") return value;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const pick = (type) => parts.find((part) => part.type === type).value;
  return `${pick("year")}-${pick("month")}-${pick("day")}T${pick("hour")}:${pick("minute")}:${pick("second")}`;
}

function normAmount(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function sameDate(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  const left = a instanceof Date ? a.getTime() : new Date(a).getTime();
  const right = b instanceof Date ? b.getTime() : new Date(b).getTime();
  if (Number.isNaN(left) && Number.isNaN(right)) return true;
  return left === right;
}

function orderFingerprint(row) {
  return JSON.stringify({
    customerName: normText(row.CustomerName || row.customerName),
    customerPhone: normText(row.CustomerPhone || row.customerPhone),
    shippingAddress: normText(row.ShippingAddress || row.shippingAddress),
    orderStatus: normText(row.OrderStatus || row.orderStatus).toLowerCase(),
    paymentMethod: normText(row.PaymentMethod || row.paymentMethod),
    shippingMethod: normText(row.ShippingMethod || row.shippingMethod),
    platformStatus: normText(row.PlatformStatus || row.platformStatus),
    totalAmount: normAmount(row.TotalAmount != null ? row.TotalAmount : row.totalAmount),
    itemAmount: normAmount(row.ItemAmount != null ? row.ItemAmount : row.itemAmount),
    discountAmount: normAmount(row.DiscountAmount != null ? row.DiscountAmount : row.discountAmount),
    shippingAmount: normAmount(row.ShippingAmount != null ? row.ShippingAmount : row.shippingAmount),
    currency: normText(row.Currency || row.currency).toUpperCase(),
    itemsJson: normText(row.ItemsJson || row.itemsJson || linesJson({ lines: row.lines })),
  });
}

function shopMatchSql() {
  return "AND ISNULL(ShopId, N'') = ISNULL(@shopId, N'')";
}

async function upsertOrder(order) {
  await ensureSchema();
  const pool = await poolPromise;
  const items = linesJson(order);
  const orderId = String(order.marketplaceOrderId);
  const shopId = order.shopId ? String(order.shopId) : null;

  const existing = await pool
    .request()
    .input("platform", order.platform)
    .input("orderId", orderId)
    .input("shopId", shopId)
    .query(`
      SELECT TOP 1
        CustomerName, CustomerPhone, ShippingAddress, OrderDate, OrderStatus,
        PaymentMethod, ShippingMethod, PlatformStatus, TotalAmount, ItemAmount, DiscountAmount, ShippingAmount,
        Currency, ItemsJson, SyncStatus, SapDocNum
      FROM dbo.MarketplaceOrder
      WHERE Platform = @platform
        AND MarketplaceOrderId = @orderId
        ${shopMatchSql()}
    `);

  const prev = existing.recordset[0];
  const nextFp = orderFingerprint({
    customerName: order.customerName,
    customerPhone: order.customerPhone,
    shippingAddress: order.shippingAddress,
    orderStatus: order.orderStatus,
    paymentMethod: order.paymentMethod,
    shippingMethod: order.shippingMethod,
    platformStatus: order.platformStatus,
    totalAmount: order.totalAmount,
    itemAmount: order.itemAmount,
    discountAmount: order.discountAmount,
    shippingAmount: order.shippingAmount,
    currency: order.currency,
    itemsJson: items,
  });

  if (!prev) {
    await pool
      .request()
      .input("platform", order.platform)
      .input("orderId", orderId)
      .input("customerName", order.customerName || null)
      .input("customerPhone", order.customerPhone || null)
      .input("shippingAddress", order.shippingAddress || null)
      .input("orderDate", order.orderDate || null)
      .input("orderStatus", order.orderStatus || null)
      .input("paymentMethod", order.paymentMethod || null)
      .input("shippingMethod", order.shippingMethod || null)
      .input("platformStatus", order.platformStatus || null)
      .input("totalAmount", order.totalAmount)
      .input("itemAmount", order.itemAmount)
      .input("discountAmount", order.discountAmount)
      .input("shippingAmount", order.shippingAmount)
      .input("currency", order.currency || null)
      .input("syncStatus", order.syncStatus || "saved")
      .input("itemsJson", items)
      .input("shopId", shopId)
      .query(`
        INSERT INTO dbo.MarketplaceOrder
        (
          Platform, MarketplaceOrderId, ShopId, CustomerName, CustomerPhone, ShippingAddress,
          OrderDate, OrderStatus, PaymentMethod, ShippingMethod, PlatformStatus, TotalAmount,
          ItemAmount, DiscountAmount, ShippingAmount,
          Currency, SyncStatus, ItemsJson, LastSyncedAt
        )
        VALUES
        (
          @platform, @orderId, @shopId, @customerName, @customerPhone, @shippingAddress,
          @orderDate, @orderStatus, @paymentMethod, @shippingMethod, @platformStatus, @totalAmount,
          @itemAmount, @discountAmount, @shippingAmount,
          @currency, @syncStatus, @itemsJson, GETDATE()
        )
      `);
    return { change: "inserted" };
  }

  const prevFp = orderFingerprint(prev);
  const dateChanged = !sameDate(prev.OrderDate, order.orderDate);
  const changed = prevFp !== nextFp || dateChanged;

  if (!changed) {
    await pool
      .request()
      .input("platform", order.platform)
      .input("orderId", orderId)
      .input("shopId", shopId)
      .query(`
        UPDATE dbo.MarketplaceOrder
        SET LastSyncedAt = GETDATE()
        WHERE Platform = @platform
          AND MarketplaceOrderId = @orderId
          ${shopMatchSql()}
      `);
    return {
      change: "unchanged",
      syncStatus: prev.SyncStatus || null,
      sapDocNum: prev.SapDocNum || null,
    };
  }

  await pool
    .request()
    .input("platform", order.platform)
    .input("orderId", orderId)
    .input("customerName", order.customerName || null)
    .input("customerPhone", order.customerPhone || null)
    .input("shippingAddress", order.shippingAddress || null)
    .input("orderDate", order.orderDate || null)
    .input("orderStatus", order.orderStatus || null)
    .input("paymentMethod", order.paymentMethod || null)
    .input("shippingMethod", order.shippingMethod || null)
    .input("platformStatus", order.platformStatus || null)
    .input("totalAmount", order.totalAmount)
    .input("itemAmount", order.itemAmount)
    .input("discountAmount", order.discountAmount)
    .input("shippingAmount", order.shippingAmount)
    .input("currency", order.currency || null)
    .input("syncStatus", order.syncStatus || prev.SyncStatus || "saved")
    .input("itemsJson", items)
    .input("shopId", shopId)
    .query(`
      UPDATE dbo.MarketplaceOrder
      SET
        CustomerName = @customerName,
        CustomerPhone = @customerPhone,
        ShippingAddress = @shippingAddress,
        OrderDate = @orderDate,
        OrderStatus = @orderStatus,
        PaymentMethod = @paymentMethod,
        ShippingMethod = @shippingMethod,
        PlatformStatus = @platformStatus,
        TotalAmount = @totalAmount,
        ItemAmount = @itemAmount,
        DiscountAmount = @discountAmount,
        ShippingAmount = @shippingAmount,
        Currency = @currency,
        SyncStatus = @syncStatus,
        ItemsJson = @itemsJson,
        ShopId = @shopId,
        LastSyncedAt = GETDATE()
      WHERE Platform = @platform
        AND MarketplaceOrderId = @orderId
        ${shopMatchSql()}
    `);

  return {
    change: "updated",
    syncStatus: prev.SyncStatus || null,
    sapDocNum: prev.SapDocNum || null,
  };
}

async function setSapDoc(platform, marketplaceOrderId, sapDocNum, syncStatus, shopId) {
  const pool = await poolPromise;

  await pool
    .request()
    .input("platform", platform)
    .input("orderId", String(marketplaceOrderId))
    .input("sapDocNum", sapDocNum || null)
    .input("syncStatus", syncStatus || "sap_ok")
    .input("shopId", shopId ? String(shopId) : null)
    .query(`
      UPDATE dbo.MarketplaceOrder
      SET SapDocNum = @sapDocNum, SyncStatus = @syncStatus, LastSyncedAt = GETDATE()
      WHERE Platform = @platform
        AND MarketplaceOrderId = @orderId
        ${shopMatchSql()}
    `);
}

function presentAmounts(order, lines) {
  if (order.ItemAmount == null && order.DiscountAmount == null && order.ShippingAmount == null) {
    const priced = splitOrderAmounts(lines, order.TotalAmount, 0);
    return {
      itemAmount: priced.itemAmount,
      discountAmount: priced.discountAmount,
      shippingAmount: 0,
    };
  }

  return {
    itemAmount: normAmount(order.ItemAmount),
    discountAmount: normAmount(order.DiscountAmount),
    shippingAmount: normAmount(order.ShippingAmount),
  };
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
      o.Id,
      o.Platform,
      o.ShopId,
      o.MarketplaceOrderId,
      o.CustomerName,
      o.CustomerPhone,
      o.ShippingAddress,
      o.OrderDate,
      o.OrderStatus,
      o.PaymentMethod,
      o.ShippingMethod,
      o.PlatformStatus,
      o.TotalAmount,
      o.ItemAmount,
      o.DiscountAmount,
      o.ShippingAmount,
      o.Currency,
      o.SyncStatus,
      o.SapDocNum,
      o.LastSyncedAt,
      o.ItemsJson
    FROM dbo.MarketplaceOrder o
    INNER JOIN dbo.MarketplaceConnection c
      ON c.Platform = o.Platform
     AND ISNULL(c.ShopId, N'') = ISNULL(o.ShopId, N'')
     AND UPPER(c.ConnectionStatus) = N'CONNECTED'
  `;

  if (platform) {
    request.input("platform", platform);
    query += " WHERE o.Platform = @platform";
  }

  query += " ORDER BY o.OrderDate DESC";

  const result = await request.query(query);
  return result.recordset.map((order) => {
    const { ItemsJson, ...rest } = order;
    const lines = parseLines(ItemsJson);
    const amounts = presentAmounts(order, lines);
    const shippingStatus = mapShippingStatus(order.PlatformStatus);
    const shippingCarrier = normText(order.ShippingMethod) || "ยังไม่ระบุ";
    const orderStatus = order.PlatformStatus
      ? mapOrderStatus(order.PlatformStatus)
      : order.OrderStatus;
    return {
      ...rest,
      OrderDate: bangkokStamp(order.OrderDate),
      LastSyncedAt: bangkokStamp(order.LastSyncedAt),
      OrderStatus: orderStatus,
      orderStatus,
      lines,
      shippingStatus,
      ShippingStatus: shippingStatus,
      shippingCarrier,
      ShippingCarrier: shippingCarrier,
      ItemAmount: amounts.itemAmount,
      DiscountAmount: amounts.discountAmount,
      ShippingAmount: amounts.shippingAmount,
      itemAmount: amounts.itemAmount,
      discountAmount: amounts.discountAmount,
      shippingAmount: amounts.shippingAmount,
    };
  });
}

module.exports = {
  upsertOrder,
  setSapDoc,
  listOrders,
};
