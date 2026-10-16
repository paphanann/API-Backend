const { poolPromise, sql } = require("../../config/database");
const { currentCompanyId } = require("./companyContext");
const { startTimer } = require("../../utils/timing");
const { splitOrderAmounts, mapShippingStatus, mapOrderStatus, clipText } = require("../../utils/normalize");
const { ensureSchema } = require("./schema");

function linesJson(order) {
  const lines = Array.isArray(order.lines) ? order.lines : [];
  return JSON.stringify(lines);
}

function normText(value) {
  if (value == null) return "";
  return String(value).trim();
}

function storedClock(value) {
  if (value == null || value === "") return value;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return value;
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
        MarketplaceOrderId, CustomerName, CustomerPhone, ShippingAddress, OrderDate, OrderStatus,
        PaymentMethod, ShippingMethod, PlatformStatus, TotalAmount, ItemAmount, DiscountAmount, ShippingAmount,
        Currency, ItemsJson, SyncStatus, SapDocNum
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
        @${prefix}platform, @${prefix}companyId, @${prefix}orderId, @${prefix}shopId, @${prefix}shopName, @${prefix}customerName, @${prefix}customerPhone, @${prefix}shippingAddress,
        @${prefix}orderDate, @${prefix}orderStatus, @${prefix}paymentMethod, @${prefix}shippingMethod, @${prefix}platformStatus, @${prefix}totalAmount,
        @${prefix}itemAmount, @${prefix}discountAmount, @${prefix}shippingAmount,
        @${prefix}currency, @${prefix}syncStatus, @${prefix}itemsJson, GETDATE()
      )`;
    });
    await request.query(`
      INSERT INTO dbo.MarketplaceOrder
      (
        Platform, CompanyId, MarketplaceOrderId, ShopId, ShopName, CustomerName, CustomerPhone, ShippingAddress,
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
        });
        continue;
      }
      updates.push({ ...row, prev });
      results.set(resultKey, {
        change: "updated",
        syncStatus: prev.SyncStatus || null,
        sapDocNum: prev.SapDocNum || null,
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

async function setSapDoc(platform, marketplaceOrderId, sapDocNum, syncStatus, shopId, companyId) {
  const pool = await poolPromise;
  const company = companyId ? String(companyId) : await currentCompanyId();

  await pool
    .request()
    .input("platform", platform)
    .input("companyId", company)
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

async function listOrders(platform, marketplaceOrderId) {
  const done = startTimer(
    `GET /api/orders${platform ? ` ${platform}` : ""}${marketplaceOrderId ? " one" : ""}`
  );
  await ensureSchema();
  const pool = await poolPromise;
  const request = pool.request();

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
      OrderDate: storedClock(order.OrderDate),
      LastSyncedAt: storedClock(order.LastSyncedAt),
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
  upsertOrders,
  setSapDoc,
  listOrders,
};
