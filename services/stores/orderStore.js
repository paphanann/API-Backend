const { poolPromise, sql } = require("../../config/database");
const { currentCompanyId } = require("./companyContext");
const { startTimer } = require("../../utils/timing");
const { splitOrderAmounts, mapShippingStatus, mapOrderStatus, clipText, roundMoney } = require("../../utils/normalize");
const { ensureSchema } = require("./schema");
const transferStore = require("./transferStore");

function linesJson(order) {
  const lines = Array.isArray(order.lines) ? order.lines : [];
  return JSON.stringify(lines);
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
  request.input(`${prefix}orderDate`, order.orderDate || null);
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
        @${prefix}currency, @${prefix}syncStatus, @${prefix}itemsJson, GETDATE()
      )`;
    });
    await request.query(`
      INSERT INTO dbo.MarketplaceOrder
      (
        Platform, CompanyId, MarketplaceOrderId, ShopId, ShopName, CustomerName, CustomerPhone, CustomerEmail, TrackingNo, ShippingAddress,
        OrderDate, OrderStatus, PaymentMethod, ShippingMethod, PlatformStatus, TotalAmount,
        ItemAmount, DiscountAmount, ShippingAmount,
        Currency, SyncStatus, ItemsJson, LastSyncedAt
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
      ShopId = @shopId,
      ShopName = COALESCE(@shopName, ShopName),
      CompanyId = @companyId,
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
      const changed = orderFingerprint(prev) !== row.nextFp || !sameDate(prev.OrderDate, row.order.orderDate);
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
  const pool = await poolPromise;
  const company = companyId ? String(companyId) : await currentCompanyId();
  const request = pool.request();
  sapKeyInputs(request, platform, marketplaceOrderId, shopId, company);
  request.input("deliveryDocNum", deliveryDocNum ? String(deliveryDocNum) : null);
  await request.query(`
    UPDATE dbo.MarketplaceOrder
    SET DeliveryDocNum = COALESCE(NULLIF(LTRIM(RTRIM(@deliveryDocNum)), N''), DeliveryDocNum)
    WHERE Platform = @platform
      AND MarketplaceOrderId = @orderId
      ${shopMatchSql()}
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

async function listOrders(platform, marketplaceOrderId) {
  const done = startTimer(
    `GET /api/orders${platform ? ` ${platform}` : ""}${marketplaceOrderId ? " one" : ""}`
  );
  await ensureSchema();
  const pool = await poolPromise;
  const request = pool.request();

  const one = Boolean(marketplaceOrderId);
  let query = `
    SELECT
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
      o.LastSyncedAt,
      CASE
        WHEN ISJSON(o.ItemsJson) = 1 THEN (SELECT COUNT(*) FROM OPENJSON(o.ItemsJson))
        ELSE 0
      END AS ItemCount,
      ${one ? "o.ItemsJson" : "CAST(NULL AS NVARCHAR(MAX)) AS ItemsJson"}
    FROM dbo.MarketplaceOrder o
    INNER JOIN dbo.MarketplaceConnection c
      ON c.Platform = o.Platform
     AND ISNULL(c.CompanyId, N'') = ISNULL(o.CompanyId, N'')
     AND ISNULL(c.ShopId, N'') = ISNULL(o.ShopId, N'')
     AND UPPER(c.ConnectionStatus) = N'CONNECTED'
  `;

  const companyId = await currentCompanyId();
  request.input("companyId", companyId);
  const filters = ["ISNULL(o.CompanyId, N'') = ISNULL(@companyId, N'')"];
  if (platform) {
    request.input("platform", platform);
    filters.push("o.Platform = @platform");
  }
  if (marketplaceOrderId) {
    request.input("orderId", String(marketplaceOrderId));
    filters.push("o.MarketplaceOrderId = @orderId");
  }
  if (filters.length) {
    query += ` WHERE ${filters.join(" AND ")}`;
  }

  query += " ORDER BY o.OrderDate DESC";

  const result = await request.query(query);
  done(`rows=${result.recordset.length}`);
  let links = new Map();
  try {
    links = await transferStore.linksForOrders(companyId);
  } catch (error) {
    console.error(error);
  }
  const rank = { success: 3, pending: 2, failed: 1 };
  return result.recordset.map((order) => {
    const { ItemsJson, ItemCount, ...rest } = order;
    const lines = parseLines(ItemsJson);
    const amounts = presentAmounts(order, lines);
    const shippingStatus = mapShippingStatus(order.PlatformStatus);
    const shippingCarrier = normText(order.ShippingMethod) || "ยังไม่ระบุ";
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
    const itemCount = lines.length || Number(ItemCount) || 0;
    return {
      ...rest,
      OrderDate: storedClock(order.OrderDate, 7 * 60 * 60 * 1000),
      LastSyncedAt: storedClock(order.LastSyncedAt),
      OrderStatus: orderStatus,
      orderStatus,
      lines,
      ...(one ? { Lines: lines, Items: lines, items: lines } : {}),
      itemCount,
      ItemCount: itemCount,
      transferStatus: link ? link.status : "",
      TransferStatus: link ? link.status : "",
      transferDocNum: link ? link.docNum : "",
      TransferDocNum: link ? link.docNum : "",
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
  setSapDoc,
  setDeliveryDoc,
  setReturnRequestDoc,
  listOrders,
  listOrdersForSap,
};
