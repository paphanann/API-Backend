const { poolPromise, sql } = require("../../config/database");
const { normalizePlatform } = require("../../utils/platform");
const { currentCompanyId } = require("./companyContext");
const { startTimer } = require("../../utils/timing");
const { splitOrderAmounts, mapShippingStatus, mapOrderStatus, clipText, roundMoney, toThaiWallDate } = require("../../utils/normalize");
const { ensureSchema } = require("./schema");
const transferStore = require("./transferStore");

function linesJson(order) {
  const lines = Array.isArray(order.lines) ? order.lines : [];
  return JSON.stringify(lines);
}

function countStoredItems(raw) {
  if (!raw) return 0;
  try {
    const lines = typeof raw === "string" ? JSON.parse(raw) : raw;
    return Array.isArray(lines) ? lines.length : 0;
  } catch {
    return 0;
  }
}

function normText(value) {
  if (value == null) return "";
  return String(value).trim();
}

function storedClock(value, offsetMs = 0) {
  if (value == null || value === "") return value;
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  const date = offsetMs ? new Date(parsed.getTime() + offsetMs) : parsed;
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
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
  return Math.abs(left - right) < 1500;
}

function lineKey(line) {
  return {
    sku: normText(line && (line.sku != null ? line.sku : line.Sku)),
    name: normText(line && (line.name != null ? line.name : line.Name)),
    qty: Number(line && (line.qty != null ? line.qty : line.Qty)) || 0,
    price: roundMoney(line && (line.price != null ? line.price : line.Price)),
  };
}

function canonicalItems(value) {
  let lines = value;
  if (typeof value === "string") {
    try {
      lines = value.trim() ? JSON.parse(value) : [];
    } catch {
      lines = [];
    }
  }
  if (!Array.isArray(lines)) lines = [];
  const keys = lines.map(lineKey).sort((a, b) =>
    `${a.sku}|${a.name}|${a.qty}|${a.price}`.localeCompare(`${b.sku}|${b.name}|${b.qty}|${b.price}`)
  );
  return JSON.stringify(keys);
}

function orderFingerprint(row) {
  return JSON.stringify({
    customerName: clipText(row.CustomerName || row.customerName, 255) || "",
    customerPhone: clipText(row.CustomerPhone || row.customerPhone, 50) || "",
    customerEmail: clipText(row.CustomerEmail || row.customerEmail || row.email, 120) || "",
    trackingNo: clipText(row.TrackingNo || row.trackingNo || row.trackingNumber, 50) || "",
    shippingAddress: clipText(row.ShippingAddress || row.shippingAddress, 500) || "",
    orderStatus: normText(row.OrderStatus || row.orderStatus).toLowerCase(),
    paymentMethod: clipText(row.PaymentMethod || row.paymentMethod, 100) || "",
    shippingMethod: clipText(row.ShippingMethod || row.shippingMethod, 100) || "",
    platformStatus: clipText(row.PlatformStatus || row.platformStatus, 80) || "",
    totalAmount: roundMoney(row.TotalAmount != null ? row.TotalAmount : row.totalAmount),
    itemAmount: roundMoney(row.ItemAmount != null ? row.ItemAmount : row.itemAmount),
    discountAmount: roundMoney(row.DiscountAmount != null ? row.DiscountAmount : row.discountAmount),
    shippingAmount: roundMoney(row.ShippingAmount != null ? row.ShippingAmount : row.shippingAmount),
    currency: normText(row.Currency || row.currency).toUpperCase(),
    itemsJson: canonicalItems(row.ItemsJson || row.itemsJson || row.lines),
  });
}

function shopMatchSql(alias = "") {
  const shop = alias ? `${alias}.ShopId` : "ShopId";
  const company = alias ? `${alias}.CompanyId` : "CompanyId";
  return `AND ISNULL(${company}, N'') = ISNULL(@companyId, N'') AND ISNULL(${shop}, N'') = ISNULL(@shopId, N'')`;
}

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

function prepareOrder(order, fallbackCompany) {
  const items = linesJson(order);
  const orderId = String(order.marketplaceOrderId);
  const shopId = order.shopId ? String(order.shopId) : null;
  const shopName = order.shopName ? clipText(order.shopName, 255) : null;
  const companyId = order.companyId ? String(order.companyId) : fallbackCompany;
  return {
    order,
    items,
    orderId,
    shopId,
    shopName,
    companyId,
    nextFp: orderFingerprint({
      customerName: order.customerName,
      customerPhone: order.customerPhone,
      customerEmail: order.email || order.customerEmail,
      trackingNo: order.trackingNo || order.trackingNumber,
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
    }),
  };
}

function bindOrderInputs(request, prefix, row, syncStatus) {
  const order = row.order;
  request.input(`${prefix}platform`, order.platform);
  request.input(`${prefix}companyId`, row.companyId);
  request.input(`${prefix}orderId`, row.orderId);
  request.input(`${prefix}customerName`, clipText(order.customerName, 255));
  request.input(`${prefix}customerPhone`, clipText(order.customerPhone, 50));
  request.input(`${prefix}customerEmail`, clipText(order.email || order.customerEmail, 120));
  request.input(`${prefix}trackingNo`, clipText(order.trackingNo || order.trackingNumber, 50));
  request.input(`${prefix}shippingAddress`, clipText(order.shippingAddress, 500));
  request.input(`${prefix}orderDate`, toThaiWallDate(order.orderDate));
  request.input(`${prefix}orderStatus`, clipText(order.orderStatus, 50));
  request.input(`${prefix}paymentMethod`, clipText(order.paymentMethod, 100));
  request.input(`${prefix}shippingMethod`, clipText(order.shippingMethod, 100));
  request.input(`${prefix}platformStatus`, clipText(order.platformStatus, 80));
  request.input(`${prefix}totalAmount`, order.totalAmount);
  request.input(`${prefix}itemAmount`, order.itemAmount);
  request.input(`${prefix}discountAmount`, order.discountAmount);
  request.input(`${prefix}shippingAmount`, order.shippingAmount);
  request.input(`${prefix}currency`, clipText(order.currency, 10));
  request.input(`${prefix}syncStatus`, syncStatus);
  request.input(`${prefix}itemsJson`, row.items);
  request.input(`${prefix}itemCount`, sql.Int, countStoredItems(row.items));
  request.input(`${prefix}shopId`, row.shopId);
  request.input(`${prefix}shopName`, row.shopName);
}

async function loadExistingOrders(db, platform, shopId, companyId, ids) {
  const found = new Map();
  for (const part of chunk(ids, 80)) {
    const request = db.request();
    request.input("platform", platform);
    request.input("companyId", companyId);
    request.input("shopId", shopId);
    const names = part.map((id, index) => {
      request.input(`id${index}`, id);
      return `@id${index}`;
    });
    const result = await request.query(`
      SELECT
        MarketplaceOrderId, CustomerName, CustomerPhone, CustomerEmail, TrackingNo, ShippingAddress, OrderDate, OrderStatus,
        PaymentMethod, ShippingMethod, PlatformStatus, TotalAmount, ItemAmount, DiscountAmount, ShippingAmount,
        Currency, ItemsJson, SyncStatus, SapDocNum, DeliveryDocNum, ReturnRequestDocNum
      FROM dbo.MarketplaceOrder
      WHERE Platform = @platform
        AND MarketplaceOrderId IN (${names.join(", ")})
        ${shopMatchSql()}
    `);
    for (const row of result.recordset) found.set(String(row.MarketplaceOrderId), row);
  }
  return found;
}

async function insertOrderRows(db, rows) {
  for (const part of chunk(rows, 15)) {
    const request = db.request();
    const values = part.map((row, index) => {
      const prefix = `r${index}`;
      bindOrderInputs(request, prefix, row, row.order.syncStatus || "saved");
      return `(
        @${prefix}platform, @${prefix}companyId, @${prefix}orderId, @${prefix}shopId, @${prefix}shopName, @${prefix}customerName, @${prefix}customerPhone, @${prefix}customerEmail, @${prefix}trackingNo, @${prefix}shippingAddress,
        @${prefix}orderDate, @${prefix}orderStatus, @${prefix}paymentMethod, @${prefix}shippingMethod, @${prefix}platformStatus, @${prefix}totalAmount,
        @${prefix}itemAmount, @${prefix}discountAmount, @${prefix}shippingAmount,
        @${prefix}currency, @${prefix}syncStatus, @${prefix}itemsJson, @${prefix}itemCount,
        CASE WHEN LOWER(REPLACE(REPLACE(LTRIM(RTRIM(ISNULL(@${prefix}platformStatus, N''))), N' ', N'_'), N'-', N'_')) IN (N'shipped', N'in_transit') THEN 1 ELSE 0 END,
        GETDATE()
      )`;
    });
    await request.query(`
      INSERT INTO dbo.MarketplaceOrder
      (
        Platform, CompanyId, MarketplaceOrderId, ShopId, ShopName, CustomerName, CustomerPhone, CustomerEmail, TrackingNo, ShippingAddress,
        OrderDate, OrderStatus, PaymentMethod, ShippingMethod, PlatformStatus, TotalAmount,
        ItemAmount, DiscountAmount, ShippingAmount,
        Currency, SyncStatus, ItemsJson, ItemCount, ShippingConfirmed, LastSyncedAt
      )
      VALUES ${values.join(",\n")}
    `);
  }
}

async function touchUnchangedOrders(db, platform, shopId, companyId, ids) {
  for (const part of chunk(ids, 80)) {
    const request = db.request();
    request.input("platform", platform);
    request.input("companyId", companyId);
    request.input("shopId", shopId);
    const names = part.map((id, index) => {
      request.input(`id${index}`, id);
      return `@id${index}`;
    });
    await request.query(`
      UPDATE dbo.MarketplaceOrder
      SET LastSyncedAt = GETDATE()
      WHERE Platform = @platform
        ${shopMatchSql()}
        AND MarketplaceOrderId IN (${names.join(", ")})
    `);
  }
}

async function updateOrderRow(db, row) {
  const request = db.request();
  const prevStatus = row.prev && row.prev.SyncStatus;
  const locked = Boolean(row.prev && row.prev.SapDocNum) || prevStatus === "sap_ok" || prevStatus === "history";
  const syncStatus = locked ? prevStatus || "saved" : row.order.syncStatus || prevStatus || "saved";
  bindOrderInputs(request, "", row, syncStatus);
  await request.query(`
    UPDATE dbo.MarketplaceOrder
    SET
      CustomerName = @customerName,
      CustomerPhone = @customerPhone,
      CustomerEmail = @customerEmail,
      TrackingNo = @trackingNo,
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
      ItemCount = @itemCount,
      ShopId = @shopId,
      ShopName = COALESCE(@shopName, ShopName),
      CompanyId = @companyId,
      ShippingConfirmed = CASE
        WHEN LOWER(REPLACE(REPLACE(LTRIM(RTRIM(ISNULL(@platformStatus, N''))), N' ', N'_'), N'-', N'_')) IN (N'shipped', N'in_transit') THEN 1
        ELSE ShippingConfirmed
      END,
      LastSyncedAt = GETDATE()
    WHERE Platform = @platform
      AND MarketplaceOrderId = @orderId
      ${shopMatchSql()}
  `);
}

async function upsertOrders(orders) {
  await ensureSchema();
  const pool = await poolPromise;
  const fallbackCompany = await currentCompanyId();
  const prepared = (Array.isArray(orders) ? orders : []).map((order) =>
    order && order.marketplaceOrderId ? prepareOrder(order, fallbackCompany) : null
  );
  const results = new Map();
  const groups = new Map();

  for (const row of prepared) {
    if (!row) continue;
    const key = `${row.companyId || ""}\0${row.order.platform}\0${row.shopId || ""}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  for (const rows of groups.values()) {
    const platform = rows[0].order.platform;
    const shopId = rows[0].shopId;
    const companyId = rows[0].companyId;
    const existing = await loadExistingOrders(pool, platform, shopId, companyId, rows.map((row) => row.orderId));
    const inserts = [];
    const updates = [];
    const unchangedIds = [];

    for (const row of rows) {
      const prev = existing.get(row.orderId);
      const resultKey = `${platform}\0${row.orderId}`;
      if (!prev) {
        inserts.push(row);
        results.set(resultKey, { change: "inserted" });
        continue;
      }
      const changed = orderFingerprint(prev) !== row.nextFp || !sameDate(prev.OrderDate, toThaiWallDate(row.order.orderDate));
      if (!changed) {
        unchangedIds.push(row.orderId);
        results.set(resultKey, {
          change: "unchanged",
          syncStatus: prev.SyncStatus || null,
          sapDocNum: prev.SapDocNum || null,
          deliveryDocNum: prev.DeliveryDocNum || null,
          returnRequestDocNum: prev.ReturnRequestDocNum || null,
        });
        continue;
      }
      updates.push({ ...row, prev });
      results.set(resultKey, {
        change: "updated",
        syncStatus: prev.SyncStatus || null,
        sapDocNum: prev.SapDocNum || null,
        deliveryDocNum: prev.DeliveryDocNum || null,
        returnRequestDocNum: prev.ReturnRequestDocNum || null,
      });
    }

    const transaction = new sql.Transaction(pool);
    await transaction.begin();
    try {
      await insertOrderRows(transaction, inserts);
      await touchUnchangedOrders(transaction, platform, shopId, companyId, unchangedIds);
      for (const row of updates) await updateOrderRow(transaction, row);
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }

  return prepared.map((row) => (row ? results.get(`${row.order.platform}\0${row.orderId}`) : null));
}

async function upsertOrder(order) {
  const [result] = await upsertOrders([order]);
  return result;
}

function sapKeyInputs(request, platform, marketplaceOrderId, shopId, companyId) {
  request.input("platform", platform);
  request.input("companyId", companyId);
  request.input("orderId", String(marketplaceOrderId));
  request.input("shopId", shopId ? String(shopId) : null);
}

async function readSapState(platform, marketplaceOrderId, shopId, companyId) {
  const pool = await poolPromise;
  const company = companyId ? String(companyId) : await currentCompanyId();
  const request = pool.request();
  sapKeyInputs(request, platform, marketplaceOrderId, shopId, company);
  const result = await request.query(`
    SELECT TOP 1 SapDocNum, SyncStatus
    FROM dbo.MarketplaceOrder
    WHERE Platform = @platform
      AND MarketplaceOrderId = @orderId
      ${shopMatchSql()}
  `);
  const row = result.recordset[0] || {};
  const sapDocNum = row.SapDocNum ? String(row.SapDocNum).trim() : "";
  return {
    sapDocNum: sapDocNum || null,
    syncStatus: row.SyncStatus || null,
  };
}

async function claimSapSend(order) {
  const pool = await poolPromise;
  const company = order.companyId ? String(order.companyId) : await currentCompanyId();
  const request = pool.request();
  sapKeyInputs(request, order.platform, order.marketplaceOrderId, order.shopId, company);
  const claim = await request.query(`
    UPDATE dbo.MarketplaceOrder
    SET SyncStatus = N'sap_sending', LastSyncedAt = GETDATE()
    WHERE Platform = @platform
      AND MarketplaceOrderId = @orderId
      ${shopMatchSql()}
      AND (SapDocNum IS NULL OR LTRIM(RTRIM(SapDocNum)) = N'')
      AND ISNULL(SyncStatus, N'') <> N'sap_ok'
      AND (
        ISNULL(SyncStatus, N'') <> N'sap_sending'
        OR LastSyncedAt < DATEADD(MINUTE, -10, GETDATE())
      )
  `);
  const state = await readSapState(order.platform, order.marketplaceOrderId, order.shopId, company);
  return {
    claimed: Boolean(claim.rowsAffected && claim.rowsAffected[0] > 0),
    sapDocNum: state.sapDocNum,
    syncStatus: state.syncStatus,
  };
}

async function setReturnRequestDoc(platform, marketplaceOrderId, returnRequestDocNum, shopId, companyId) {
  const pool = await poolPromise;
  const company = companyId ? String(companyId) : await currentCompanyId();
  const request = pool.request();
  sapKeyInputs(request, platform, marketplaceOrderId, shopId, company);
  request.input("returnRequestDocNum", returnRequestDocNum ? String(returnRequestDocNum) : null);
  await request.query(`
    UPDATE dbo.MarketplaceOrder
    SET ReturnRequestDocNum = COALESCE(NULLIF(LTRIM(RTRIM(@returnRequestDocNum)), N''), ReturnRequestDocNum)
    WHERE Platform = @platform
      AND MarketplaceOrderId = @orderId
      ${shopMatchSql()}
  `);
}

async function setDeliveryDoc(platform, marketplaceOrderId, deliveryDocNum, shopId, companyId) {
  await finishDelivery(
    {
      platform,
      marketplaceOrderId,
      shopId,
      companyId,
    },
    deliveryDocNum
  );
}

async function claimDeliverySend(order) {
  const pool = await poolPromise;
  const company = order.companyId ? String(order.companyId) : await currentCompanyId();
  const request = pool.request();
  sapKeyInputs(request, order.platform, order.marketplaceOrderId, order.shopId, company);
  const claim = await request.query(`
    UPDATE dbo.MarketplaceOrder
    SET SyncStatus = N'delivery_sending', LastSyncedAt = GETDATE()
    WHERE Platform = @platform
      AND MarketplaceOrderId = @orderId
      ${shopMatchSql()}
      AND NULLIF(LTRIM(RTRIM(SapDocNum)), N'') IS NOT NULL
      AND (DeliveryDocNum IS NULL OR LTRIM(RTRIM(DeliveryDocNum)) = N'')
      AND (
        ISNULL(SyncStatus, N'') <> N'delivery_sending'
        OR LastSyncedAt < DATEADD(MINUTE, -10, GETDATE())
      )
  `);
  const state = await readDeliveryState(order.platform, order.marketplaceOrderId, order.shopId, company);
  return {
    claimed: Boolean(claim.rowsAffected && claim.rowsAffected[0] > 0),
    deliveryDocNum: state.deliveryDocNum,
    sapDocNum: state.sapDocNum,
  };
}

async function readDeliveryState(platform, marketplaceOrderId, shopId, companyId) {
  const pool = await poolPromise;
  const company = companyId ? String(companyId) : await currentCompanyId();
  const request = pool.request();
  sapKeyInputs(request, platform, marketplaceOrderId, shopId, company);
  const result = await request.query(`
    SELECT TOP 1 SapDocNum, DeliveryDocNum, SyncStatus
    FROM dbo.MarketplaceOrder
    WHERE Platform = @platform
      AND MarketplaceOrderId = @orderId
      ${shopMatchSql()}
  `);
  const row = result.recordset[0] || {};
  return {
    sapDocNum: row.SapDocNum ? String(row.SapDocNum).trim() : null,
    deliveryDocNum: row.DeliveryDocNum ? String(row.DeliveryDocNum).trim() : null,
    syncStatus: row.SyncStatus || null,
  };
}

async function finishDelivery(order, deliveryDocNum) {
  const pool = await poolPromise;
  const company = order.companyId ? String(order.companyId) : await currentCompanyId();
  const request = pool.request();
  sapKeyInputs(request, order.platform, order.marketplaceOrderId, order.shopId, company);
  request.input("deliveryDocNum", deliveryDocNum ? String(deliveryDocNum) : null);
  await request.query(`
    UPDATE dbo.MarketplaceOrder
    SET
      DeliveryDocNum = COALESCE(NULLIF(LTRIM(RTRIM(@deliveryDocNum)), N''), DeliveryDocNum),
      SyncStatus = CASE
        WHEN NULLIF(LTRIM(RTRIM(@deliveryDocNum)), N'') IS NOT NULL THEN N'sap_ok'
        ELSE SyncStatus
      END,
      NextRetryAt = CASE
        WHEN NULLIF(LTRIM(RTRIM(@deliveryDocNum)), N'') IS NOT NULL THEN NULL
        ELSE NextRetryAt
      END,
      LastSyncedAt = GETDATE()
    WHERE Platform = @platform
      AND MarketplaceOrderId = @orderId
      ${shopMatchSql()}
  `);
}

async function failDelivery(order) {
  const pool = await poolPromise;
  const company = order.companyId ? String(order.companyId) : await currentCompanyId();
  const request = pool.request();
  sapKeyInputs(request, order.platform, order.marketplaceOrderId, order.shopId, company);
  await request.query(`
    UPDATE dbo.MarketplaceOrder
    SET SyncStatus = N'delivery_error',
        NextRetryAt = DATEADD(MINUTE, 30, GETDATE()),
        LastSyncedAt = GETDATE()
    WHERE Platform = @platform
      AND MarketplaceOrderId = @orderId
      ${shopMatchSql()}
      AND (DeliveryDocNum IS NULL OR LTRIM(RTRIM(DeliveryDocNum)) = N'')
  `);
}

async function markShippingConfirmed(order) {
  const pool = await poolPromise;
  const company = order.companyId ? String(order.companyId) : await currentCompanyId();
  const request = pool.request();
  sapKeyInputs(request, order.platform, order.marketplaceOrderId, order.shopId, company);
  await request.query(`
    UPDATE dbo.MarketplaceOrder
    SET ShippingConfirmed = 1
    WHERE Platform = @platform
      AND MarketplaceOrderId = @orderId
      ${shopMatchSql()}
      AND ISNULL(ShippingConfirmed, 0) = 0
  `);
}

async function saveInvoice(order, invoice) {
  const pool = await poolPromise;
  const company = order.companyId ? String(order.companyId) : await currentCompanyId();
  const request = pool.request();
  sapKeyInputs(request, order.platform, order.marketplaceOrderId, order.shopId, company);
  request.input("invoiceDocNum", invoice.docNum ? String(invoice.docNum) : null);
  request.input("invoiceDocEntry", invoice.docEntry ? String(invoice.docEntry) : null);
  request.input("invoiceStatus", invoice.status || null);
  request.input("invoiceError", invoice.error ? String(invoice.error).slice(0, 500) : null);
  request.input("settlementStatus", invoice.settlementStatus || null);
  request.input("settlementNote", invoice.settlementNote ? String(invoice.settlementNote).slice(0, 300) : null);
  await request.query(`
    UPDATE dbo.MarketplaceOrder
    SET
      InvoiceDocNum = COALESCE(NULLIF(LTRIM(RTRIM(@invoiceDocNum)), N''), InvoiceDocNum),
      InvoiceDocEntry = COALESCE(NULLIF(LTRIM(RTRIM(@invoiceDocEntry)), N''), InvoiceDocEntry),
      InvoiceStatus = COALESCE(@invoiceStatus, InvoiceStatus),
      InvoiceError = @invoiceError,
      SettlementStatus = COALESCE(@settlementStatus, SettlementStatus),
      SettlementNote = COALESCE(@settlementNote, SettlementNote),
      NextRetryAt = CASE WHEN @invoiceStatus = N'error' THEN DATEADD(MINUTE, 30, GETDATE()) ELSE NULL END
    WHERE Platform = @platform
      AND MarketplaceOrderId = @orderId
      ${shopMatchSql()}
  `);
}

async function saveReturnState(order, state) {
  const pool = await poolPromise;
  const company = order.companyId ? String(order.companyId) : await currentCompanyId();
  const request = pool.request();
  sapKeyInputs(request, order.platform, order.marketplaceOrderId, order.shopId, company);
  request.input("returnDocNum", state.returnDocNum ? String(state.returnDocNum) : null);
  request.input("creditDocNum", state.creditDocNum ? String(state.creditDocNum) : null);
  request.input("returnStatus", state.status || null);
  await request.query(`
    UPDATE dbo.MarketplaceOrder
    SET
      ReturnRequestDocNum = COALESCE(NULLIF(LTRIM(RTRIM(@returnDocNum)), N''), ReturnRequestDocNum),
      CreditDocNum = COALESCE(NULLIF(LTRIM(RTRIM(@creditDocNum)), N''), CreditDocNum),
      ReturnStatus = COALESCE(@returnStatus, ReturnStatus),
      NextRetryAt = CASE
        WHEN @returnStatus IN (N'review', N'error') THEN DATEADD(MINUTE, 30, GETDATE())
        WHEN @returnStatus = N'created' THEN NULL
        ELSE NextRetryAt
      END
    WHERE Platform = @platform
      AND MarketplaceOrderId = @orderId
      ${shopMatchSql()}
  `);
}

function recoveryStatusSql(values) {
  return values.map((value) => `N'${value}'`).join(", ");
}

async function listSapRecoveryOrders(limit = 30) {
  await ensureSchema();
  const pool = await poolPromise;
  const companyId = await currentCompanyId();
  const soStatuses = recoveryStatusSql(["ready_to_ship", "on_hold", "pending"]);
  const cancelStatuses = recoveryStatusSql(["cancelled", "canceled", "in_cancel"]);
  const deliveryStatuses = recoveryStatusSql([
    "shipped",
    "in_transit",
    "to_confirm_receive",
    "completed",
    "complete",
    "delivered",
    "success",
    "สำเร็จ",
  ]);
  const returnStatuses = recoveryStatusSql(["to_return", "returned", "จัดส่งไม่สำเร็จ"]);
  const confirmedLater = recoveryStatusSql([
    "completed",
    "complete",
    "delivered",
    "shipped",
    "in_transit",
    "success",
    "สำเร็จ",
    "to_confirm_receive",
  ]);
  const take = Math.max(1, Math.min(Number(limit) || 30, 100));
  const result = await pool.request().input("companyId", companyId).input("limit", sql.Int, take).query(`
    SELECT TOP (@limit)
      Platform,
      CompanyId,
      ShopId,
      MarketplaceOrderId,
      CustomerName,
      CustomerPhone,
      CustomerEmail,
      TrackingNo,
      ShippingAddress,
      PaymentMethod,
      ShippingMethod,
      ShopName,
      OrderDate,
      OrderStatus,
      PlatformStatus,
      ItemsJson,
      SapDocNum,
      DeliveryDocNum,
      InvoiceDocNum,
      InvoiceStatus,
      ReturnRequestDocNum,
      CreditDocNum,
      ReturnStatus,
      ShippingConfirmed,
      SyncStatus
    FROM dbo.MarketplaceOrder o WITH (NOLOCK)
    WHERE ISNULL(o.CompanyId, N'') = ISNULL(@companyId, N'')
      AND o.OrderDate >= '2026-10-01T00:00:00'
      AND (o.NextRetryAt IS NULL OR o.NextRetryAt <= GETDATE())
      AND (
        (
          (o.SapDocNum IS NULL OR LTRIM(RTRIM(o.SapDocNum)) = N'')
          AND LOWER(REPLACE(REPLACE(LTRIM(RTRIM(ISNULL(o.PlatformStatus, N''))), N' ', N'_'), N'-', N'_')) IN (${soStatuses})
          AND (
            ISNULL(o.SyncStatus, N'') NOT IN (N'sap_sending', N'history')
            OR (o.SyncStatus = N'sap_sending' AND o.LastSyncedAt < DATEADD(MINUTE, -10, GETDATE()))
          )
        )
        OR
        (
          NULLIF(LTRIM(RTRIM(o.SapDocNum)), N'') IS NOT NULL
          AND (o.DeliveryDocNum IS NULL OR LTRIM(RTRIM(o.DeliveryDocNum)) = N'')
          AND (
            LOWER(REPLACE(REPLACE(LTRIM(RTRIM(ISNULL(o.PlatformStatus, N''))), N' ', N'_'), N'-', N'_')) IN (${deliveryStatuses})
            OR ISNULL(o.ShippingConfirmed, 0) = 1
            OR (
              NULLIF(LTRIM(RTRIM(ISNULL(o.TrackingNo, N''))), N'') IS NOT NULL
              AND LOWER(REPLACE(REPLACE(LTRIM(RTRIM(ISNULL(o.PlatformStatus, N''))), N' ', N'_'), N'-', N'_')) IN (${confirmedLater})
            )
          )
          AND (
            ISNULL(o.SyncStatus, N'') <> N'delivery_sending'
            OR o.LastSyncedAt < DATEADD(MINUTE, -10, GETDATE())
          )
        )
        OR
        (
          NULLIF(LTRIM(RTRIM(o.DeliveryDocNum)), N'') IS NOT NULL
          AND (o.InvoiceDocNum IS NULL OR LTRIM(RTRIM(o.InvoiceDocNum)) = N'')
          AND ISNULL(o.InvoiceStatus, N'') <> N'ok'
          AND LOWER(REPLACE(REPLACE(LTRIM(RTRIM(ISNULL(o.PlatformStatus, N''))), N' ', N'_'), N'-', N'_')) NOT IN (${cancelStatuses})
        )
        OR
        (
          LOWER(REPLACE(REPLACE(LTRIM(RTRIM(ISNULL(o.PlatformStatus, N''))), N' ', N'_'), N'-', N'_')) IN (${returnStatuses})
          AND ISNULL(o.ReturnStatus, N'') NOT IN (N'sending', N'created')
          AND (o.ReturnRequestDocNum IS NULL OR LTRIM(RTRIM(o.ReturnRequestDocNum)) = N'')
        )
        OR
        (
          (o.SapDocNum IS NULL OR LTRIM(RTRIM(o.SapDocNum)) = N'')
          AND LOWER(REPLACE(REPLACE(LTRIM(RTRIM(ISNULL(o.PlatformStatus, N''))), N' ', N'_'), N'-', N'_')) IN (${cancelStatuses})
          AND ISNULL(o.SyncStatus, N'') <> N'sap_sending'
        )
      )
    ORDER BY
      CASE
        WHEN NULLIF(LTRIM(RTRIM(o.DeliveryDocNum)), N'') IS NOT NULL
         AND (o.InvoiceDocNum IS NULL OR LTRIM(RTRIM(o.InvoiceDocNum)) = N'') THEN 0
        WHEN NULLIF(LTRIM(RTRIM(o.SapDocNum)), N'') IS NOT NULL
         AND (o.DeliveryDocNum IS NULL OR LTRIM(RTRIM(o.DeliveryDocNum)) = N'') THEN 1
        ELSE 2
      END,
      o.OrderDate ASC,
      o.Id ASC
  `);

  return result.recordset.map((row) => ({
    platform: row.Platform,
    companyId: row.CompanyId,
    shopId: row.ShopId,
    marketplaceOrderId: row.MarketplaceOrderId,
    customerName: row.CustomerName,
    customerPhone: row.CustomerPhone,
    email: row.CustomerEmail,
    trackingNo: row.TrackingNo,
    shippingAddress: row.ShippingAddress,
    paymentMethod: row.PaymentMethod,
    shippingMethod: row.ShippingMethod,
    shopName: row.ShopName,
    orderDate: row.OrderDate,
    orderStatus: row.OrderStatus,
    platformStatus: row.PlatformStatus,
    sapDocNum: row.SapDocNum ? String(row.SapDocNum).trim() : null,
    deliveryDocNum: row.DeliveryDocNum ? String(row.DeliveryDocNum).trim() : null,
    invoiceDocNum: row.InvoiceDocNum ? String(row.InvoiceDocNum).trim() : null,
    returnRequestDocNum: row.ReturnRequestDocNum ? String(row.ReturnRequestDocNum).trim() : null,
    creditDocNum: row.CreditDocNum ? String(row.CreditDocNum).trim() : null,
    returnStatus: row.ReturnStatus || "",
    shippingConfirmed: Number(row.ShippingConfirmed) === 1,
    syncStatus: row.SyncStatus || "",
    lines: parseLines(row.ItemsJson),
  }));
}

async function deferSapLookup(order) {
  const pool = await poolPromise;
  const company = order.companyId ? String(order.companyId) : await currentCompanyId();
  const request = pool.request();
  sapKeyInputs(request, order.platform, order.marketplaceOrderId, order.shopId, company);
  await request.query(`
    UPDATE dbo.MarketplaceOrder
    SET NextRetryAt = DATEADD(DAY, 1, GETDATE())
    WHERE Platform = @platform
      AND MarketplaceOrderId = @orderId
      ${shopMatchSql()}
      AND (SapDocNum IS NULL OR LTRIM(RTRIM(SapDocNum)) = N'')
  `);
}

async function setSapDoc(platform, marketplaceOrderId, sapDocNum, syncStatus, shopId, companyId) {
  const pool = await poolPromise;
  const company = companyId ? String(companyId) : await currentCompanyId();
  const request = pool.request();
  sapKeyInputs(request, platform, marketplaceOrderId, shopId, company);
  request.input("sapDocNum", sapDocNum ? String(sapDocNum) : null);
  request.input("syncStatus", syncStatus || "sap_ok");
  await request.query(`
    UPDATE dbo.MarketplaceOrder
    SET
      SapDocNum = COALESCE(NULLIF(LTRIM(RTRIM(@sapDocNum)), N''), SapDocNum),
      SyncStatus = CASE
        WHEN NULLIF(LTRIM(RTRIM(@sapDocNum)), N'') IS NOT NULL THEN @syncStatus
        WHEN NULLIF(LTRIM(RTRIM(SapDocNum)), N'') IS NOT NULL THEN SyncStatus
        WHEN SyncStatus = N'history' THEN SyncStatus
        ELSE @syncStatus
      END,
      NextRetryAt = CASE
        WHEN @syncStatus = N'sap_error' AND NULLIF(LTRIM(RTRIM(ISNULL(SapDocNum, @sapDocNum))), N'') IS NULL
          THEN DATEADD(MINUTE, 30, GETDATE())
        WHEN NULLIF(LTRIM(RTRIM(@sapDocNum)), N'') IS NOT NULL THEN NULL
        ELSE NextRetryAt
      END,
      LastSyncedAt = GETDATE()
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

const DELIVERY_DUE = new Set(["shipped", "in_transit"]);

function sapUi(order) {
  const doc = String(order.SapDocNum || "").trim();
  const delivery = String(order.DeliveryDocNum || "").trim();
  const sync = String(order.SyncStatus || "").toLowerCase();
  const status = String(order.PlatformStatus || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  const due = DELIVERY_DUE.has(status) || Number(order.ShippingConfirmed) === 1;
  if (!doc && sync.includes("error")) return "so_fail";
  if (!doc) return "wait";
  if (delivery) return "ok";
  if (sync.includes("delivery_error")) return "delivery_fail";
  if (due || sync === "delivery_sending") return "delivery_wait";
  return "ok";
}

function mappedStatusSql(alias = "o") {
  const raw = `LOWER(REPLACE(REPLACE(LTRIM(RTRIM(COALESCE(NULLIF(${alias}.PlatformStatus, N''), ${alias}.OrderStatus, N''))), N' ', N'_'), N'-', N'_'))`;
  return `CASE
    WHEN ${raw} LIKE N'%return%' OR ${raw} LIKE N'%refund%' OR ${raw} LIKE N'%shipped_back%' OR ${raw} = N'failed' OR ${raw} LIKE N'%lost%' OR ${raw} LIKE N'%damaged%' OR ${raw} LIKE N'%คืนสินค้า%' OR ${raw} LIKE N'%คืนเงิน%' OR ${raw} LIKE N'%จัดส่งไม่สำเร็จ%' THEN N'returned'
    WHEN ${raw} LIKE N'%cancel%' OR ${raw} LIKE N'%void%' OR ${raw} LIKE N'%in_cancel%' THEN N'cancelled'
    WHEN ${raw} LIKE N'%unpaid%' OR ${raw} LIKE N'%รอชำระ%' THEN N'unpaid'
    WHEN ${raw} IN (N'completed', N'complete', N'delivered', N'confirmed', N'สำเร็จ') OR ${raw} LIKE N'%success%' THEN N'success'
    WHEN ${raw} IN (N'shipped', N'in_transit', N'to_confirm_receive', N'partially_shipping') OR ${raw} LIKE N'%กำลังจัดส่ง%' THEN N'shipping'
    ELSE N'pending'
  END`;
}

function sapKeySql(alias = "o") {
  const status = mappedStatusSql(alias);
  const inv = `LOWER(LTRIM(RTRIM(COALESCE(${alias}.InvoiceStatus, N''))))`;
  const sync = `LOWER(LTRIM(RTRIM(COALESCE(${alias}.SyncStatus, N''))))`;
  return `CASE
    WHEN ${status} = N'cancelled' THEN N'cancelled'
    WHEN NULLIF(LTRIM(RTRIM(${alias}.InvoiceDocNum)), N'') IS NOT NULL THEN N'invoice_ok'
    WHEN ${inv} LIKE N'%fail%' OR ${inv} LIKE N'%error%' OR ${inv} LIKE N'%ล้มเหลว%' THEN N'invoice_fail'
    WHEN NULLIF(LTRIM(RTRIM(${alias}.DeliveryDocNum)), N'') IS NOT NULL THEN N'delivery_ok'
    WHEN ${sync} LIKE N'%delivery_error%' OR ${sync} LIKE N'%delivery_fail%' THEN N'delivery_fail'
    WHEN NULLIF(LTRIM(RTRIM(${alias}.SapDocNum)), N'') IS NOT NULL THEN N'delivery_wait'
    WHEN ${sync} LIKE N'%error%' OR ${sync} LIKE N'%fail%' THEN N'so_fail'
    ELSE N'wait'
  END`;
}

function bangkokDay(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || "").trim());
  if (!match) return null;
  const y = Number(match[1]);
  const mo = Number(match[2]);
  const d = Number(match[3]);
  if (!y || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return { y, mo, d };
}

async function listOrders(platform, marketplaceOrderId, options = {}) {
  const done = startTimer(
    `GET /api/orders${platform ? ` ${platform}` : ""}${marketplaceOrderId ? " one" : ""}`
  );
  await ensureSchema();
  const pool = await poolPromise;
  const request = pool.request();

  const one = Boolean(marketplaceOrderId);
  const columns = one
    ? `
      o.Id,
      o.Platform,
      o.CompanyId,
      o.ShopId,
      COALESCE(o.ShopName, c.ShopName) AS ShopName,
      o.MarketplaceOrderId,
      o.CustomerName,
      o.CustomerPhone,
      o.CustomerEmail,
      o.TrackingNo,
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
      o.DeliveryDocNum,
      o.ShippingConfirmed,
      o.InvoiceDocNum,
      o.InvoiceDocEntry,
      o.InvoiceStatus,
      o.InvoiceError,
      o.SettlementStatus,
      o.SettlementNote,
      o.ReturnStatus,
      o.LastSyncedAt,
      ISNULL(o.ItemCount, 0) AS ItemCount,
      o.ItemsJson`
    : `
      o.Platform,
      o.CompanyId,
      o.ShopId,
      COALESCE(o.ShopName, c.ShopName) AS ShopName,
      o.MarketplaceOrderId,
      o.CustomerName,
      o.OrderDate,
      o.OrderStatus,
      o.PlatformStatus,
      o.TotalAmount,
      o.ItemAmount,
      o.DiscountAmount,
      o.ShippingAmount,
      o.SyncStatus,
      o.SapDocNum,
      o.DeliveryDocNum,
      o.ShippingConfirmed,
      o.InvoiceDocNum,
      o.InvoiceStatus,
      o.SettlementStatus,
      o.LastSyncedAt,
      ISNULL(o.ItemCount, 0) AS ItemCount`;
  let query = `
    SELECT
      ${columns}
    FROM dbo.MarketplaceOrder o WITH (NOLOCK)
    INNER JOIN dbo.MarketplaceConnection c WITH (NOLOCK)
      ON c.Platform = o.Platform
     AND ISNULL(c.CompanyId, N'') = ISNULL(o.CompanyId, N'')
     AND ISNULL(c.ShopId, N'') = ISNULL(o.ShopId, N'')
     AND UPPER(c.ConnectionStatus) = N'CONNECTED'
  `;

  const companyId = await currentCompanyId();
  request.input("companyId", companyId);
  const filters = [companyId ? "o.CompanyId = @companyId" : "ISNULL(o.CompanyId, N'') = ISNULL(@companyId, N'')"];
  if (platform) {
    const platforms = [
      ...new Set(
        String(platform)
          .split(",")
          .map((item) => normalizePlatform(item.trim()))
          .filter(Boolean)
      ),
    ];
    if (platforms.length === 1) {
      request.input("platform", platforms[0]);
      filters.push("o.Platform = @platform");
    } else if (platforms.length > 1) {
      const names = platforms.map((item, index) => {
        const name = `platform${index}`;
        request.input(name, item);
        return `@${name}`;
      });
      filters.push(`o.Platform IN (${names.join(", ")})`);
    }
  }
  if (marketplaceOrderId) {
    request.input("orderId", String(marketplaceOrderId));
    filters.push("o.MarketplaceOrderId = @orderId");
  }
  const fromDay = bangkokDay(options.from);
  const toDay = bangkokDay(options.to);
  if (!one && fromDay && toDay) {
    request.input("fromDate", sql.DateTime2, new Date(Date.UTC(fromDay.y, fromDay.mo - 1, fromDay.d, 0, 0, 0)));
    request.input("toDate", sql.DateTime2, new Date(Date.UTC(toDay.y, toDay.mo - 1, toDay.d + 1, 0, 0, 0)));
    filters.push("o.OrderDate >= @fromDate AND o.OrderDate < @toDate");
  }
  const page = Number(options.page);
  const paged = !one && Number.isFinite(page) && page > 0;
  const pageSize = paged ? Math.min(100, Math.max(1, Number(options.pageSize) || 20)) : 0;
  const pageNo = paged ? Math.max(1, Math.floor(page)) : 0;
  let trValues = [];
  if (!one) {
    const shopIds = [
      ...new Set(
        String(options.shopId || "")
          .split(",")
          .map((item) => item.trim())
          .filter((item) => item && item !== "all" && item !== "-")
      ),
    ];
    if (shopIds.length === 1) {
      request.input("shopId", sql.NVarChar(100), shopIds[0]);
      filters.push("(o.ShopId = @shopId OR ISNULL(o.ShopName, c.ShopName) = @shopId)");
    } else if (shopIds.length > 1) {
      const parts = shopIds.map((item, index) => {
        const name = `shopId${index}`;
        request.input(name, sql.NVarChar(100), item);
        return `(o.ShopId = @${name} OR ISNULL(o.ShopName, c.ShopName) = @${name})`;
      });
      filters.push(`(${parts.join(" OR ")})`);
    }
    const statuses = [
      ...new Set(
        String(options.status || "")
          .split(",")
          .map((item) => item.trim().toLowerCase())
          .filter((item) => ["unpaid", "pending", "shipping", "success", "cancelled", "returned"].includes(item))
      ),
    ];
    if (statuses.length === 1) {
      request.input("status", sql.NVarChar(30), statuses[0]);
      filters.push(`${mappedStatusSql("o")} = @status`);
    } else if (statuses.length > 1) {
      const names = statuses.map((item, index) => {
        const name = `status${index}`;
        request.input(name, sql.NVarChar(30), item);
        return `@${name}`;
      });
      filters.push(`${mappedStatusSql("o")} IN (${names.join(", ")})`);
    }
    const sapKeys = [
      ...new Set(
        String(options.sap || "")
          .split(",")
          .map((item) => item.trim())
          .filter((item) => item && item !== "all")
          .flatMap((item) => {
            if (item === "so_ok") return ["delivery_wait", "delivery_ok", "invoice_ok"];
            if (item === "delivery_ok" || item === "ok") return ["delivery_ok", "invoice_ok"];
            if (["wait", "so_fail", "delivery_fail", "delivery_wait", "cancelled", "invoice_ok", "invoice_fail"].includes(item)) {
              return [item];
            }
            return [];
          })
      ),
    ];
    if (String(options.sap || "").trim() && String(options.sap || "").trim() !== "all") {
      if (!sapKeys.length) {
        filters.push("1 = 0");
      } else if (sapKeys.length === 1) {
        request.input("sap", sql.NVarChar(30), sapKeys[0]);
        filters.push(`${sapKeySql("o")} = @sap`);
      } else {
        const names = sapKeys.map((item, index) => {
          const name = `sap${index}`;
          request.input(name, sql.NVarChar(30), item);
          return `@${name}`;
        });
        filters.push(`${sapKeySql("o")} IN (${names.join(", ")})`);
      }
    }
    const q = String(options.q || "").trim().replace(/[%_\[\]]/g, "");
    if (q) {
      request.input("q", sql.NVarChar(120), `%${q}%`);
      if (options.wide) {
        filters.push(`(
          o.MarketplaceOrderId LIKE @q
          OR ISNULL(o.SapDocNum, N'') LIKE @q
          OR ISNULL(o.CustomerName, N'') LIKE @q
          OR ISNULL(o.ShopName, N'') LIKE @q
          OR ISNULL(c.ShopName, N'') LIKE @q
        )`);
      } else {
        filters.push("o.MarketplaceOrderId LIKE @q");
      }
    }
    const trRaw = String(options.tr || "").trim();
    trValues = [
      ...new Set(
        trRaw
          .split(",")
          .map((item) => item.trim().toLowerCase())
          .filter((item) => ["ready", "sent", "done", "fail"].includes(item))
      ),
    ];
    if (trRaw && trRaw.toLowerCase() !== "all") {
      if (!trValues.length) {
        filters.push("1 = 0");
      } else {
        const parts = [];
        if (trValues.includes("ready")) parts.push("trlink.TrStatus IS NULL");
        if (trValues.includes("sent")) parts.push("trlink.TrStatus = N'pending'");
        if (trValues.includes("done")) parts.push("trlink.TrStatus = N'success'");
        if (trValues.includes("fail")) parts.push("trlink.TrStatus = N'failed'");
        filters.push(parts.length === 1 ? parts[0] : `(${parts.join(" OR ")})`);
      }
    }
  }
  if (!one && trValues.length) {
    query += `
    OUTER APPLY (
      SELECT TOP 1 t.Status AS TrStatus
      FROM dbo.StockTransferOrder l
      INNER JOIN dbo.StockTransfer t ON t.Id = l.TransferId
      WHERE ISNULL(t.CompanyId, N'') = ISNULL(@companyId, N'')
        AND t.Status IN (N'pending', N'success', N'failed')
        AND l.SalesOrderId <> N''
        AND (
          l.SalesOrderId = o.MarketplaceOrderId
          OR (
            NULLIF(LTRIM(RTRIM(o.SapDocNum)), N'') IS NOT NULL
            AND (
              l.SalesOrderId = o.SapDocNum
              OR l.SalesOrderId = CONCAT(N'SO-', o.SapDocNum)
            )
          )
        )
      ORDER BY CASE t.Status WHEN N'success' THEN 3 WHEN N'pending' THEN 2 ELSE 1 END DESC, t.Id DESC
    ) trlink`;
  }
  if (filters.length) {
    query += ` WHERE ${filters.join(" AND ")}`;
  }

  const fromSql = query.slice(query.indexOf("FROM "));
  let recordset;
  let total = 0;
  if (paged) {
    request.input("offset", sql.Int, (pageNo - 1) * pageSize);
    request.input("pageSize", sql.Int, pageSize);
    const counted = await request.query(`SELECT COUNT_BIG(*) AS Total ${fromSql}`);
    total = Number(counted.recordset[0].Total) || 0;
    const result = await request.query(`
      SELECT ${columns} ${fromSql}
      ORDER BY o.OrderDate DESC
      OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY
    `);
    recordset = result.recordset;
  } else {
    const result = await request.query(`${query} ORDER BY o.OrderDate DESC`);
    recordset = result.recordset;
    total = recordset.length;
  }
  done(`rows=${recordset.length}${paged ? ` total=${total}` : ""}`);
  let links = new Map();
  if (paged && options.links) {
    const keys = [];
    for (const order of recordset) {
      if (order.MarketplaceOrderId) keys.push(String(order.MarketplaceOrderId));
      if (order.SapDocNum) {
        keys.push(String(order.SapDocNum));
        keys.push(`SO-${order.SapDocNum}`);
      }
    }
    try {
      links = await transferStore.linksForKeys(companyId, keys);
    } catch (error) {
      console.error(error);
    }
  } else if (!paged) {
    try {
      links = await transferStore.linksForOrders(companyId);
    } catch (error) {
      console.error(error);
    }
  }
  const rank = { success: 3, pending: 2, failed: 1 };
  const items = recordset.map((order) => {
    const lines = one ? parseLines(order.ItemsJson) : [];
    const amounts = one ? presentAmounts(order, lines) : null;
    const orderStatus = order.PlatformStatus
      ? mapOrderStatus(order.PlatformStatus)
      : order.OrderStatus;
    const keys = [
      order.MarketplaceOrderId,
      order.SapDocNum,
      order.SapDocNum ? `SO-${order.SapDocNum}` : "",
    ];
    let link = null;
    for (const key of keys) {
      const row = key ? links.get(String(key)) : null;
      if (row && (!link || (rank[row.status] || 0) > (rank[link.status] || 0))) link = row;
    }
    const itemCount = lines.length || Number(order.ItemCount) || 0;
    const sap = sapUi(order);
    const shared = {
      MarketplaceOrderId: order.MarketplaceOrderId,
      Platform: order.Platform,
      CompanyId: order.CompanyId,
      ShopId: order.ShopId,
      ShopName: order.ShopName,
      CustomerName: order.CustomerName,
      OrderDate: storedClock(order.OrderDate),
      OrderStatus: orderStatus,
      TotalAmount: order.TotalAmount,
      ItemAmount: one ? amounts.itemAmount : order.ItemAmount,
      DiscountAmount: one ? amounts.discountAmount : order.DiscountAmount,
      ShippingAmount: one ? amounts.shippingAmount : order.ShippingAmount,
      SyncStatus: order.SyncStatus,
      SapDocNum: order.SapDocNum,
      DeliveryDocNum: order.DeliveryDocNum,
      InvoiceDocNum: order.InvoiceDocNum,
      InvoiceStatus: order.InvoiceStatus,
      SettlementStatus: order.SettlementStatus,
      LastSyncedAt: storedClock(order.LastSyncedAt),
      itemCount,
      ItemCount: itemCount,
      transferStatus: link ? link.status : "",
      TransferStatus: link ? link.status : "",
      transferDocNum: link ? link.docNum : "",
      TransferDocNum: link ? link.docNum : "",
      sapUi: sap,
      SapUi: sap,
    };
    if (!one) {
      const compact = {};
      for (const [key, value] of Object.entries(shared)) {
        if (value == null || value === "") continue;
        compact[key] = value;
      }
      return compact;
    }

    const { ItemsJson, ItemCount, ...rest } = order;
    const shippingStatus = mapShippingStatus(order.PlatformStatus);
    const shippingCarrier = normText(order.ShippingMethod) || "ยังไม่ระบุ";
    return {
      ...rest,
      ...shared,
      orderStatus,
      lines,
      Lines: lines,
      Items: lines,
      items: lines,
      shippingStatus,
      ShippingStatus: shippingStatus,
      shippingCarrier,
      ShippingCarrier: shippingCarrier,
      itemAmount: amounts.itemAmount,
      discountAmount: amounts.discountAmount,
      shippingAmount: amounts.shippingAmount,
    };
  });
  if (paged) {
    return { items, total, page: pageNo, pageSize };
  }
  return items;
}

async function listOrdersForSap() {
  await ensureSchema();
  const pool = await poolPromise;
  const companyId = await currentCompanyId();
  const result = await pool.request().input("companyId", companyId).query(`
    SELECT
      Platform,
      CompanyId,
      ShopId,
      MarketplaceOrderId,
      CustomerName,
      CustomerPhone,
      CustomerEmail,
      TrackingNo,
      ShippingAddress,
      PaymentMethod,
      ShippingMethod,
      ShopName,
      OrderDate,
      OrderStatus,
      PlatformStatus,
      ItemsJson
    FROM dbo.MarketplaceOrder
    WHERE ISNULL(CompanyId, N'') = ISNULL(@companyId, N'')
      AND ISNULL(SyncStatus, N'') <> N'sap_ok'
      AND (SapDocNum IS NULL OR LTRIM(RTRIM(SapDocNum)) = N'')
    ORDER BY OrderDate ASC, Id ASC
  `);

  return result.recordset.map((row) => ({
    platform: row.Platform,
    companyId: row.CompanyId,
    shopId: row.ShopId,
    marketplaceOrderId: row.MarketplaceOrderId,
    customerName: row.CustomerName,
    customerPhone: row.CustomerPhone,
    email: row.CustomerEmail,
    trackingNo: row.TrackingNo,
    shippingAddress: row.ShippingAddress,
    paymentMethod: row.PaymentMethod,
    shippingMethod: row.ShippingMethod,
    shopName: row.ShopName,
    orderDate: row.OrderDate,
    orderStatus: row.OrderStatus,
    platformStatus: row.PlatformStatus,
    lines: parseLines(row.ItemsJson),
  }));
}

module.exports = {
  upsertOrder,
  upsertOrders,
  claimSapSend,
  claimDeliverySend,
  setSapDoc,
  deferSapLookup,
  setDeliveryDoc,
  finishDelivery,
  failDelivery,
  markShippingConfirmed,
  saveInvoice,
  saveReturnState,
  setReturnRequestDoc,
  listOrders,
  listOrdersForSap,
  listSapRecoveryOrders,
};
