const https = require("https");
const axios = require("axios");

const { text } = require("../../utils/normalize");

const PLATFORM_CARD_ENV = {
  Shopee: "SAP_CARD_CODE_SHOPEE",
  TikTok: "SAP_CARD_CODE_TIKTOK",
  Lazada: "SAP_CARD_CODE_LAZADA",
  "My Order": "SAP_CARD_CODE_MYORDER",
};

const PLATFORM_CARD_DEFAULT = {
  TikTok: "CEC00001",
  Shopee: "CEC00002",
  Lazada: "CEC00003",
  "My Order": "CEC00004",
};

function getConfig() {
  const baseUrl = String(process.env.SAP_BASE_URL || "")
    .replace(/\/$/, "")
    .replace(/\/b1s\/v1$/i, "");
  return {
    baseUrl,
    companyDb: String(process.env.SAP_COMPANY_DB || "").trim(),
    username: String(process.env.SAP_USERNAME || "").trim(),
    password: process.env.SAP_PASSWORD || "",
    cardCode: String(process.env.SAP_CARD_CODE || "").trim(),
  };
}

function cardCodeFor(platform) {
  const key = PLATFORM_CARD_ENV[platform];
  const fromEnv = key ? String(process.env[key] || "").trim() : "";
  if (fromEnv) return fromEnv;
  if (PLATFORM_CARD_DEFAULT[platform]) return PLATFORM_CARD_DEFAULT[platform];
  return getConfig().cardCode;
}

function isConfigured() {
  const { baseUrl, companyDb, username, password } = getConfig();
  return Boolean(baseUrl && companyDb && username && password);
}

function client() {
  const { baseUrl } = getConfig();
  const insecure = String(process.env.SAP_TLS_INSECURE || "").toLowerCase() === "true";

  return axios.create({
    baseURL: `${baseUrl}/b1s/v1`,
    timeout: 30000,
    httpsAgent: insecure ? new https.Agent({ rejectUnauthorized: false }) : undefined,
    headers: { "Content-Type": "application/json" },
  });
}

let session = null;

async function login() {
  const { companyDb, username, password } = getConfig();

  if (!isConfigured()) {
    return null;
  }

  const http = client();
  const response = await http.post("/Login", {
    CompanyDB: companyDb,
    UserName: username,
    Password: password,
  });

  session = {
    sessionId: response.data && response.data.SessionId,
    cookies: response.headers["set-cookie"],
  };

  return session;
}

function sessionHeaders() {
  const headers = { "Content-Type": "application/json" };

  if (session && session.sessionId) {
    headers.Cookie = `B1SESSION=${session.sessionId}`;
  }

  if (session && session.cookies) {
    headers.Cookie = session.cookies.join("; ");
  }

  return headers;
}


function odataKey(code) {
  return String(code).replace(/'/g, "''");
}

function clipName(value, fallback) {
  const name = String(value || fallback || "").trim();
  return (name || String(fallback || "")).slice(0, 100);
}

function collectProductItems(product) {
  const items = [];
  const seen = new Set();
  const push = (sku, itemName) => {
    const itemCode = String(sku || "").trim();
    if (!itemCode || itemCode === "-" || seen.has(itemCode)) return;
    seen.add(itemCode);
    items.push({
      itemCode,
      itemName: clipName(itemName, itemCode),
      platform: product.platform,
    });
  };

  push(product.sku, product.name);
  for (const variant of product.variants || []) {
    const option = String(variant.option || "").trim();
    const label = option && option.toLowerCase() !== "active"
      ? `${product.name || ""} ${option}`.trim()
      : product.name;
    push(variant.sku, label);
  }
  return items;
}

async function upsertItem(item) {
  if (!isConfigured()) return null;

  const itemCode = String(item.itemCode || "").trim().slice(0, 50);
  if (!itemCode || itemCode === "-") return null;

  if (!session) await login();

  const http = client();
  const payload = {
    ItemName: clipName(item.itemName, itemCode),
  };
  if (item.platform) payload.ForeignName = String(item.platform).slice(0, 100);

  const path = `/Items('${odataKey(itemCode)}')`;

  const save = async () => {
    const headers = sessionHeaders();
    try {
      const found = await http.get(path, { headers });
      const inventory = String(found.data && found.data.InventoryItem || "").toUpperCase();
      if (inventory === "TYES") return itemCode;
      await http.patch(path, payload, { headers });
      return itemCode;
    } catch (error) {
      const status = error.response && error.response.status;
      if (status !== 404) throw error;
      await http.post("/Items", {
        ItemCode: itemCode,
        ItemsGroupCode: Number(process.env.SAP_ITEM_GROUP || 100),
        SalesItem: "tYES",
        PurchaseItem: "tNO",
        InventoryItem: "tNO",
        ...payload,
      }, { headers });
      return itemCode;
    }
  };

  try {
    return await save();
  } catch (error) {
    const status = error.response && error.response.status;
    if (status === 401 || status === 301) {
      await login();
      return save();
    }
    const sapMessage =
      error.response &&
      error.response.data &&
      error.response.data.error &&
      error.response.data.error.message &&
      error.response.data.error.message.value;
    throw new Error(sapMessage || error.message || "บันทึกสินค้าใน SAP ไม่สำเร็จ");
  }
}

const PLATFORM_FOREIGN = new Set(["shopee", "tiktok", "lazada"]);

function matchKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[/,|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isInventoryItem(item) {
  return String(item.InventoryItem || "").toUpperCase() === "TYES";
}

function isPlatformPlaceholder(item) {
  const foreign = String(item.ForeignName || "").toLowerCase();
  return PLATFORM_FOREIGN.has(foreign) && !isInventoryItem(item);
}

let masterCache = { at: 0, items: null };

function clearMasterCache() {
  masterCache = { at: 0, items: null };
  catalogCache = { at: 0, map: null };
}

async function listMasterItems() {
  if (masterCache.items && Date.now() - masterCache.at < 10 * 60 * 1000) {
    return masterCache.items;
  }
  if (!isConfigured()) return [];
  if (!session) await login();

  const http = client();
  const items = [];
  const selectWithApiCode =
    "ItemCode,ItemName,ForeignName,InventoryItem,QuantityOnStock,InventoryUOM,U_Itemcode_api";
  const selectBasic = "ItemCode,ItemName,ForeignName,InventoryItem,QuantityOnStock,InventoryUOM";
  let select = selectWithApiCode;
  let path = `/Items?$select=${select}&$orderby=ItemCode`;

  while (path && items.length < 5000) {
    let data;
    try {
      const response = await http.get(path, {
        headers: { ...sessionHeaders(), Prefer: "odata.maxpagesize=100" },
      });
      data = response.data;
    } catch (error) {
      const message = sapErrorMessage(error, "");
      if (select !== selectBasic && /U_Itemcode_api/i.test(message)) {
        select = selectBasic;
        path = `/Items?$select=${select}&$orderby=ItemCode`;
        continue;
      }
      const status = error.response && error.response.status;
      if (status === 401 || status === 301) {
        await login();
        continue;
      }
      throw new Error(message || error.message || "ดึงสินค้าจาก SAP ไม่สำเร็จ");
    }
    for (const row of (data && data.value) || []) {
      items.push(row);
    }
    const next = data && (data["odata.nextLink"] || data["@odata.nextLink"]);
    if (!next) break;
    path = String(next).replace(/^https?:\/\/[^/]+\/b1s\/v\d+/i, "");
  }

  masterCache = { at: Date.now(), items };
  return items;
}

function sapErrorMessage(error, fallback) {
  const sapMessage =
    error.response &&
    error.response.data &&
    error.response.data.error &&
    error.response.data.error.message &&
    error.response.data.error.message.value;
  return sapMessage || error.message || fallback;
}

async function sapCall(method, path, { body, params } = {}) {
  if (!isConfigured()) {
    throw new Error("ยังไม่ได้ตั้งค่า SAP");
  }
  if (!session) await login();

  const send = () =>
    client().request({
      method,
      url: path,
      data: body,
      params,
      headers: sessionHeaders(),
    });

  try {
    const { data } = await send();
    return data;
  } catch (error) {
    const status = error.response && error.response.status;
    if (status === 401 || status === 301) {
      await login();
      const { data } = await send();
      return data;
    }
    throw new Error(sapErrorMessage(error, "เรียก SAP ไม่สำเร็จ"));
  }
}

async function listWarehouses() {
  const load = (select) =>
    sapCall("GET", "/Warehouses", {
      params: {
        $select: select,
        $orderby: "WarehouseCode",
        $top: 200,
      },
    });

  let data;
  try {
    data = await load("WarehouseCode,WarehouseName,Inactive");
  } catch (error) {
    if (!/Inactive/i.test(error.message || "")) throw error;
    data = await load("WarehouseCode,WarehouseName");
  }

  return ((data && data.value) || [])
    .filter((row) => String(row.Inactive || "").toUpperCase() !== "TYES")
    .map((row) => ({
      code: String(row.WarehouseCode || "").trim(),
      name: String(row.WarehouseName || "").trim(),
    }))
    .filter((row) => row.code);
}

async function listInventoryTransferRequests() {
  const data = await sapCall("GET", "/InventoryTransferRequests", {
    params: {
      $select:
        "DocEntry,DocNum,DocDate,DueDate,FromWarehouse,ToWarehouse,Comments,DocumentStatus,StockTransferLines",
      $orderby: "DocEntry desc",
      $top: 100,
    },
  });
  return (data && data.value) || [];
}

async function createInventoryTransferRequest(doc) {
  return sapCall("POST", "/InventoryTransferRequests", { body: doc });
}

async function listStockItems() {
  const items = await listMasterItems();
  return items
    .filter((item) => String(item.ItemCode || "").trim() && isInventoryItem(item))
    .map((item) => ({
      sku: String(item.ItemCode).trim(),
      name: String(item.ItemName || "").trim(),
      stock: Math.round(Number(item.QuantityOnStock) || 0),
      unit: String(item.InventoryUOM || "").trim() || "ชิ้น",
    }));
}

function buildMasterIndex(items) {
  const byApi = new Map();
  const byCode = new Map();
  const byName = new Map();

  for (const item of items) {
    const code = String(item.ItemCode || "").trim();
    if (!code) continue;
    const meta = {
      code,
      inventory: isInventoryItem(item),
      placeholder: isPlatformPlaceholder(item),
      nameKey: matchKey(item.ItemName),
    };
    byCode.set(code, meta);

    const apiCode = String(item.U_Itemcode_api || "").trim();
    if (apiCode) {
      if (!byApi.has(apiCode)) byApi.set(apiCode, []);
      byApi.get(apiCode).push(meta);
    }

    if (!meta.nameKey) continue;
    if (!byName.has(meta.nameKey)) byName.set(meta.nameKey, []);
    byName.get(meta.nameKey).push(meta);
  }

  return { byApi, byCode, byName };
}

function pickBestMeta(list) {
  if (!list || !list.length) return null;
  const inventory = list.filter((m) => m.inventory);
  const pool = inventory.length ? inventory : list;
  return pool.slice().sort((a, b) => String(a.code).localeCompare(String(b.code)))[0];
}

function resolveByName(index, label, { inventoryOnly = false } = {}) {
  const key = matchKey(label);
  if (!key || key.length < 4) return null;

  const exactList = index.byName.get(key) || [];
  const exact = pickBestMeta(inventoryOnly ? exactList.filter((m) => m.inventory) : exactList);
  if (exact) return exact.code;

  // SAP ItemName มักถูกตัดสั้นกว่าชื่อใน marketplace — อนุญาต prefix match
  let best = null;
  let bestScore = 0;
  for (const [nameKey, metas] of index.byName.entries()) {
    if (nameKey.length < 12) continue;
    const matched =
      key === nameKey ||
      (key.startsWith(nameKey) && nameKey.length >= 20) ||
      (nameKey.startsWith(key) && key.length >= 20);
    if (!matched) continue;
    const pool = inventoryOnly ? metas.filter((m) => m.inventory) : metas;
    const candidate = pickBestMeta(pool);
    if (!candidate) continue;
    const score = Math.min(key.length, nameKey.length);
    if (
      score > bestScore ||
      (score === bestScore && candidate.inventory && !(best && best.inventory))
    ) {
      best = candidate;
      bestScore = score;
    }
  }
  return best ? best.code : null;
}

//แผนที่
function describeSapMatch(sapItemCode) {
  const code = sapItemCode || null;
  return {
    sapItemCode: code,
    problem: code ? null : "ไม่พบสินค้าใน SAP",
    statusProblem: code ? "พร้อมขาย" : "ไม่พบสินค้าใน SAP",
  };
}

let catalogCache = { at: 0, map: null };

function catalogCards() {
  const cards = new Set(Object.values(PLATFORM_CARD_DEFAULT));
  for (const platform of Object.keys(PLATFORM_CARD_DEFAULT)) {
    const code = cardCodeFor(platform);
    if (code) cards.add(code);
  }
  return [...cards];
}

async function fetchCatalogRows() {
  const filter = catalogCards().map((code) => `CardCode eq '${odataString(code)}'`).join(" or ");
  const rows = [];
  let path = "/AlternateCatNum";
  let params = { $select: "ItemCode,CardCode,Substitute", $filter: filter };

  while (path) {
    const data = await sapCall("GET", path, { params });
    for (const row of (data && data.value) || []) rows.push(row);
    const next = data && (data["odata.nextLink"] || data["@odata.nextLink"]);
    if (!next) break;
    path = String(next).replace(/^https?:\/\/[^/]+\/b1s\/v\d+/i, "");
    params = undefined;
  }
  return rows;
}

async function catalogIndex() {
  if (catalogCache.map && Date.now() - catalogCache.at < 10 * 60 * 1000) {
    return catalogCache.map;
  }
  const map = new Map();
  for (const row of await fetchCatalogRows()) {
    const card = String(row.CardCode || "").trim();
    const sku = String(row.Substitute || "").trim();
    const itemCode = String(row.ItemCode || "").trim();
    if (!card || !sku || !itemCode) continue;
    const key = `${card}\0${sku}`;
    const list = map.get(key) || [];
    if (!list.includes(itemCode)) list.push(itemCode);
    map.set(key, list);
  }

  catalogCache = { at: Date.now(), map };
  return map;
}

function platformFromForeign(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "tiktok") return "TikTok";
  if (raw === "shopee") return "Shopee";
  if (raw === "lazada") return "Lazada";
  return "";
}

function catalogHits(map, platform, sku) {
  // ItemCode จาก OSCN ที่ CardCode ของแพลตฟอร์ม และ Substitute เท่ากับ SKU
  const card = cardCodeFor(platform);
  const code = String(sku || "").trim();
  if (!card || !code || code === "-") return [];
  return map.get(`${card}\0${code}`) || [];
}

function lookupSku(sku, fallback) {
  const code = String(sku || "").trim();
  if (code && code !== "-") return code;
  const parent = String(fallback || "").trim();
  return parent && parent !== "-" ? parent : "";
}

function catalogMissMessage(platform, sku, match) {
  const card = cardCodeFor(platform) || platform || "";
  const code = String(sku || "").trim() || "-";
  if (match && match.problem && /มากกว่า 1/.test(match.problem)) {
    return `SKU ${code} ตรงกับรหัสสินค้าใน OSCN มากกว่า 1 รายการ ของ ${card}`;
  }
  return `SKU ${code} ยังไม่ได้ผูกใน OSCN ของ ${card}`;
}

async function matchFromCatalog(map, platform, sku) {
  const hits = catalogHits(map, platform, sku);
  if (hits.length > 1) {
    return {
      sapItemCode: null,
      problem: `SKU ${sku} ตรงกับรหัสสินค้าใน OSCN มากกว่า 1 รายการ`,
      statusProblem: "ตรงกับรหัสสินค้าใน OSCN มากกว่า 1 รายการ",
    };
  }
  return describeSapMatch(hits[0] || null);
}

async function mapProduct(product) {
  const catalog = await catalogIndex();
  const variants = await Promise.all(
    (product.variants || []).map(async (variant) => ({
      ...variant,
      ...(await matchFromCatalog(catalog, product.platform, lookupSku(variant.sku, product.sku))),
    }))
  );

  let sapItemCode = null;
  if (!variants.length) {
    sapItemCode = (await matchFromCatalog(catalog, product.platform, lookupSku(product.sku))).sapItemCode;
  } else {
    const codes = [...new Set(variants.map((variant) => variant.sapItemCode).filter(Boolean))];
    if (codes.length === 1 && variants.every((variant) => variant.sapItemCode)) {
      sapItemCode = codes[0];
    }
  }

  const unmapped = variants.filter((variant) => !variant.sapItemCode).length;
  const statusProblem = !variants.length
    ? describeSapMatch(sapItemCode).statusProblem
    : unmapped === 0
      ? "พร้อมขาย"
      : unmapped === variants.length
        ? "ไม่พบสินค้าใน SAP"
        : "บางรุ่นไม่พบสินค้าใน SAP";

  return {
    ...product,
    variants,
    sapItemCode,
    problem: unmapped ? "ไม่พบสินค้าใน SAP" : null,
    statusProblem,
  };
}

async function pushProducts() {
  return { saved: 0, failed: 0 };
}

async function pushStoredProducts(platform) {
  const productStore = require("../stores/productStore");
  const rows = await productStore.listProducts(platform);
  const products = rows.map((row) => ({
    platform: row.Platform,
    sku: row.Sku,
    name: row.Name,
    variants: row.variants || [],
  }));
  return pushProducts(products);
}

async function mapStoredProducts(platform) {
  clearMasterCache();
  const productStore = require("../stores/productStore");
  const rows = await productStore.listProducts(platform);
  let mapped = 0;
  for (const row of rows) {
    const product = {
      platform: row.Platform,
      productId: row.ProductId,
      sku: row.Sku,
      name: row.Name,
      variants: row.variants || [],
    };
    const next = await mapProduct(product);
    await productStore.saveVariantMap(product.platform, product.productId, next.variants, row.ShopId);
    mapped += next.variants.filter((variant) => variant.sapItemCode).length;
  }
  return mapped;
}

function odataString(value) {
  return String(value == null ? "" : value).replace(/'/g, "''");
}

async function findSalesOrder(order) {
  if (!isConfigured()) return null;
  if (!session) await login();

  const cardCode = cardCodeFor(order.platform);
  const orderNo = String(order.marketplaceOrderId || "").trim();
  if (!cardCode || !orderNo) return null;

  const filter =
    `NumAtCard eq '${odataString(orderNo)}' and CardCode eq '${odataString(cardCode)}'`;

  const load = async () => {
    const http = client();
    const { data } = await http.get("/Orders", {
      headers: sessionHeaders(),
      params: {
        $select: "DocNum,DocEntry,NumAtCard,CardCode,Comments,Cancelled",
        $filter: filter,
        $top: 5,
      },
    });
    return (data && data.value) || [];
  };

  let rows;
  try {
    rows = await load();
  } catch (error) {
    const status = error.response && error.response.status;
    if (status === 401 || status === 301) {
      await login();
      rows = await load();
    } else {
      throw error;
    }
  }

  if (!rows.length) return null;
  const shopId = String(order.shopId || "");
  const matched = shopId
    ? rows.find((row) => String(row.Comments || "").includes(shopId))
    : null;
  const row = matched || rows[0];
  const docNum = row && (row.DocNum || row.DocEntry);
  return docNum ? String(docNum) : null;
}

function orderIsCancelled(order) {
  const status = String(
    (order && (order.platformStatus || order.PlatformStatus || order.orderStatus || order.OrderStatus)) || ""
  )
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  return status === "cancelled" || status === "canceled";
}

async function cancelSalesOrder(order) {
  if (!isConfigured()) return null;
  const cardCode = cardCodeFor(order.platform);
  const orderNo = String(order.marketplaceOrderId || "").trim();
  if (!cardCode || !orderNo) return null;

  const data = await sapCall("GET", "/Orders", {
    params: {
      $select: "DocNum,DocEntry,Cancelled",
      $filter: `NumAtCard eq '${odataString(orderNo)}' and CardCode eq '${odataString(cardCode)}'`,
      $top: 5,
    },
  });
  const rows = (data && data.value) || [];
  const row = rows.find((item) => String(item.Cancelled || "").toUpperCase() !== "TYES") || rows[0];
  if (!row || row.DocEntry == null) return null;
  if (String(row.Cancelled || "").toUpperCase() === "TYES") {
    return String(row.DocNum || row.DocEntry);
  }

  try {
    await sapCall("POST", `/Orders(${row.DocEntry})/Cancel`);
  } catch (error) {
    if (!/already been cancel|already cancelled|already canceled|is canceled|is cancelled/i.test(error.message || "")) {
      throw error;
    }
  }
  return String(row.DocNum || row.DocEntry);
}

async function findDelivery(order) {
  const cardCode = cardCodeFor(order.platform);
  const orderNo = String(order.marketplaceOrderId || "").trim();
  if (!cardCode || !orderNo) return null;
  const data = await sapCall("GET", "/DeliveryNotes", {
    params: {
      $select: "DocNum,DocEntry,Cancelled",
      $filter: `NumAtCard eq '${odataString(orderNo)}' and CardCode eq '${odataString(cardCode)}'`,
      $top: 5,
    },
  });
  const rows = (data && data.value) || [];
  const row = rows.find((item) => String(item.Cancelled || "").toUpperCase() !== "TYES") || null;
  return row && (row.DocNum || row.DocEntry) ? String(row.DocNum || row.DocEntry) : null;
}

async function createDelivery(order) {
  if (!isConfigured() || orderIsCancelled(order)) return null;
  const existing = await findDelivery(order);
  if (existing) return existing;

  const cardCode = cardCodeFor(order.platform);
  const orderNo = String(order.marketplaceOrderId || "").trim();
  if (!cardCode || !orderNo) return null;

  const data = await sapCall("GET", "/Orders", {
    params: {
      $select: "DocNum,DocEntry,Cancelled,DocumentStatus,DocumentLines",
      $filter: `NumAtCard eq '${odataString(orderNo)}' and CardCode eq '${odataString(cardCode)}'`,
      $top: 5,
    },
  });
  const orders = ((data && data.value) || []).filter(
    (item) => String(item.Cancelled || "").toUpperCase() !== "TYES"
  );
  const source = orders.find((item) => String(item.DocumentStatus || "") === "bost_Open") || orders[0];
  if (!source || source.DocEntry == null) return null;

  const lines = (source.DocumentLines || [])
    .map((line) => ({
      lineNum: line.LineNum,
      quantity: Number(line.RemainingOpenQuantity != null ? line.RemainingOpenQuantity : line.Quantity) || 0,
    }))
    .filter((line) => line.lineNum != null && line.quantity > 0);
  if (!lines.length) return findDelivery(order);

  const payload = {
    CardCode: cardCode,
    NumAtCard: orderNo.slice(0, 100),
    Comments: [order.platform, orderNo].filter(Boolean).join(" ").slice(0, 254),
    ...(await ensureMarketplaceFields(order)),
    DocumentLines: lines.map((line) => ({
      BaseType: 17,
      BaseEntry: source.DocEntry,
      BaseLine: line.lineNum,
      Quantity: line.quantity,
    })),
  };

  const posted = await sapCall("POST", "/DeliveryNotes", { body: payload });
  const docNum = posted && (posted.DocNum || posted.DocEntry);
  return docNum ? String(docNum) : findDelivery(order);
}

async function findReturnRequest(order) {
  const cardCode = cardCodeFor(order.platform);
  const orderNo = String(order.marketplaceOrderId || "").trim();
  if (!cardCode || !orderNo) return null;
  const data = await sapCall("GET", "/ReturnRequest", {
    params: {
      $select: "DocNum,DocEntry,Cancelled",
      $filter: `NumAtCard eq '${odataString(orderNo)}' and CardCode eq '${odataString(cardCode)}'`,
      $top: 5,
    },
  });
  const rows = (data && data.value) || [];
  const row = rows.find((item) => String(item.Cancelled || "").toUpperCase() !== "TYES") || null;
  return row && (row.DocNum || row.DocEntry) ? String(row.DocNum || row.DocEntry) : null;
}

async function loadBaseDocument(path, order) {
  const cardCode = cardCodeFor(order.platform);
  const orderNo = String(order.marketplaceOrderId || "").trim();
  if (!cardCode || !orderNo) return null;
  const data = await sapCall("GET", path, {
    params: {
      $select: "DocNum,DocEntry,Cancelled,DocumentStatus,DocumentLines",
      $filter: `NumAtCard eq '${odataString(orderNo)}' and CardCode eq '${odataString(cardCode)}'`,
      $top: 5,
    },
  });
  const rows = ((data && data.value) || []).filter(
    (item) => String(item.Cancelled || "").toUpperCase() !== "TYES"
  );
  return rows.find((item) => String(item.DocumentStatus || "") === "bost_Open") || rows[0] || null;
}

function copyLines(source) {
  return (source.DocumentLines || [])
    .map((line) => ({
      lineNum: line.LineNum,
      quantity: Number(line.Quantity) || Number(line.RemainingOpenQuantity) || 0,
    }))
    .filter((line) => line.lineNum != null && line.quantity > 0);
}

async function createReturnRequest(order) {
  if (!isConfigured()) return null;
  const existing = await findReturnRequest(order);
  if (existing) return existing;

  const cardCode = cardCodeFor(order.platform);
  const orderNo = String(order.marketplaceOrderId || "").trim();
  if (!cardCode || !orderNo) return null;

  const delivery = await loadBaseDocument("/DeliveryNotes", order);
  const source = delivery || (await loadBaseDocument("/Orders", order));
  if (!source || source.DocEntry == null) return null;
  const lines = copyLines(source);
  if (!lines.length) return null;

  const payload = {
    CardCode: cardCode,
    NumAtCard: orderNo.slice(0, 100),
    Comments: [order.platform, orderNo].filter(Boolean).join(" ").slice(0, 254),
    ...(await ensureMarketplaceFields(order)),
    DocumentLines: lines.map((line) => ({
      BaseType: delivery ? 15 : 17,
      BaseEntry: source.DocEntry,
      BaseLine: line.lineNum,
      Quantity: line.quantity,
    })),
  };

  const posted = await sapCall("POST", "/ReturnRequest", { body: payload });
  const docNum = posted && (posted.DocNum || posted.DocEntry);
  return docNum ? String(docNum) : findReturnRequest(order);
}

const readyCustomers = new Set();

function sapDocDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

async function ensureCustomer(platform) {
  const cardCode = cardCodeFor(platform);
  if (!cardCode) {
    throw new Error(`ยังไม่มีรหัสลูกค้า SAP สำหรับ ${platform || "แพลตฟอร์มนี้"}`);
  }
  if (readyCustomers.has(cardCode)) return cardCode;

  let existing = null;
  try {
    existing = await sapCall("GET", `/BusinessPartners('${odataKey(cardCode)}')`, {
      params: { $select: "CardCode" },
    });
  } catch (error) {
    if (!/No matching records|-2028|not found|does not exist/i.test(error.message || "")) throw error;
  }

  if (!existing) {
    throw new Error(`ไม่พบรหัสลูกค้า ${cardCode} ใน SAP`);
  }

  readyCustomers.add(cardCode);
  return cardCode;
}

async function lineItemCode(line, platform) {
  const sku = lookupSku(line && line.sku);
  if (!sku) return null;
  const match = await matchFromCatalog(await catalogIndex(), platform, sku);
  if (match.sapItemCode) return match.sapItemCode;
  throw new Error(catalogMissMessage(platform, sku, match));
}

async function resolveSalesOrderLines(order) {
  const lines = (order.lines || []).filter((line) => text(line.sku));
  const catalog = await catalogIndex();
  const errors = [];
  const resolved = [];
  const seenErrors = new Set();

  for (const line of lines) {
    const sku = lookupSku(line.sku);
    const match = await matchFromCatalog(catalog, order.platform, sku);
    if (!match.sapItemCode) {
      const message = catalogMissMessage(order.platform, sku, match);
      if (!seenErrors.has(message)) {
        seenErrors.add(message);
        errors.push(message);
      }
      continue;
    }
    resolved.push({ line, itemCode: match.sapItemCode });
  }

  return { errors, resolved };
}

async function assignPlatformCatalogs() {
  const items = await listMasterItems();
  const existing = new Set();
  for (const row of await fetchCatalogRows()) {
    const itemCode = String(row.ItemCode || "").trim();
    const card = String(row.CardCode || "").trim();
    if (itemCode && card) existing.add(`${itemCode}\0${card}`);
  }

  let created = 0;
  let skipped = 0;
  let failed = 0;
  const errors = [];

  for (const item of items) {
    if (!isPlatformPlaceholder(item)) continue;
    const platform = platformFromForeign(item.ForeignName);
    const card = cardCodeFor(platform);
    const itemCode = String(item.ItemCode || "").trim();
    if (!platform || !card || !itemCode) continue;
    if (existing.has(`${itemCode}\0${card}`)) {
      skipped += 1;
      continue;
    }

    try {
      await sapCall("POST", "/AlternateCatNum", {
        body: {
          ItemCode: itemCode,
          CardCode: card,
          Substitute: itemCode.slice(0, 50),
        },
      });
      existing.add(`${itemCode}\0${card}`);
      created += 1;
    } catch (error) {
      failed += 1;
      if (errors.length < 8) errors.push(`${itemCode}: ${error.message}`);
    }
  }

  clearMasterCache();
  return { created, skipped, failed, errors };
}

async function deletePlaceholderItems() {
  const items = await listMasterItems();
  const targets = items.filter(isPlatformPlaceholder);
  let deleted = 0;
  let failed = 0;
  const errors = [];
  for (const item of targets) {
    const code = String(item.ItemCode || "").trim();
    if (!code) continue;
    try {
      await sapCall("DELETE", `/Items('${odataKey(code)}')`);
      deleted += 1;
    } catch (error) {
      failed += 1;
      if (errors.length < 5) errors.push(`${code}: ${error.message}`);
    }
  }
  clearMasterCache();
  return { found: targets.length, deleted, failed, errors };
}

function clipSap(value, max) {
  const raw = text(value, "");
  if (!raw || raw === "-") return "";
  return raw.length <= max ? raw : raw.slice(0, max);
}

function clipEmail(value, max) {
  const raw = text(value, "");
  if (!raw || raw === "-") return "";
  if (raw.length <= max) return raw;
  const at = raw.lastIndexOf("@");
  if (at <= 0) return raw.slice(0, max);
  const domain = raw.slice(at);
  if (domain.length >= max) return domain.slice(domain.length - max);
  return raw.slice(0, max - domain.length) + domain;
}

function paymentChoice(value) {
  const raw = String(value || "").trim();
  if (!raw || raw === "-") return null;
  const lower = raw.toLowerCase();
  if (lower.includes("cod") || lower.includes("cash on delivery")) {
    return { value: "COD", description: "Cash On Delivery" };
  }
  if (lower.includes("transfer") || lower.includes("mobile banking")) {
    return { value: "Transfer", description: "Transfer" };
  }
  if (lower.includes("pay later") || lower.includes("paylater")) {
    return { value: "PayLater", description: "PayLater" };
  }
  if (lower.includes("prompt")) return { value: "PromptPay", description: "PromptPay" };
  if (lower.includes("shopee")) return { value: "ShopeePay", description: "ShopeePay" };
  if (lower.includes("true")) return { value: "TrueMoney", description: "TrueMoney" };
  if (lower.includes("card") || lower.includes("credit") || lower.includes("debit")) {
    return { value: "Credit Card", description: "Credit Card" };
  }
  return { value: raw.slice(0, 15), description: raw.slice(0, 50) };
}

let paymentValues = null;

async function loadPaymentValues() {
  if (paymentValues) return paymentValues;
  const data = await sapCall("GET", "/UserFieldsMD", {
    params: { $filter: "TableName eq 'ORDR' and Name eq 'MK_Payment'" },
  });
  const row = ((data && data.value) || [])[0];
  if (!row) throw new Error("ไม่พบฟิลด์ MK_Payment ใน SAP");
  const list = Array.isArray(row.ValidValuesMD) ? row.ValidValuesMD : [];
  paymentValues = {
    fieldId: row.FieldID,
    values: new Set(list.map((item) => item.Value)),
    list,
  };
  return paymentValues;
}

async function ensurePaymentValue(choice) {
  if (!choice) return null;
  const known = await loadPaymentValues();
  if (known.values.has(choice.value)) return choice.value;
  const added = { Value: choice.value, Description: choice.description || choice.value };
  await sapCall("PATCH", `/UserFieldsMD(TableName='ORDR',FieldID=${known.fieldId})`, {
    body: { ValidValuesMD: [added] },
  });
  known.list = [...known.list, added];
  known.values.add(choice.value);
  return choice.value;
}

let emailSize = 30;

async function widenEmailField() {
  // Service Layer ยังเก็บได้แค่ 30 ตัว แม้คอลัมน์จะกว้างกว่า ส่งเกินกว่านั้นแล้วค่าจะหาย
  emailSize = 30;
  return emailSize;
}

const SERVICE_LEVELS = new Set([
  "standard",
  "standard shipping",
  "next-day delivery",
  "bulky shipping",
  "dropship",
  "dropshipping",
]);

function transportChoice(value) {
  const raw = String(value || "").trim();
  if (!raw || raw === "-") return null;
  const lower = raw.toLowerCase();
  if (SERVICE_LEVELS.has(lower)) return null;
  if (lower.includes("flash")) return { value: "FLASH", description: "FLASH" };
  if (lower.includes("kerry") || lower.includes("kex")) return { value: "KEX", description: "KEX" };
  if (lower.includes("thailand post") || lower.includes("ไปรษณีย์") || lower.includes("ems")) {
    return { value: "THP", description: "Thai Post" };
  }
  if (lower.includes("spx")) return { value: "SPX Express", description: "SPX Express" };
  if (lower.includes("shp food")) return { value: "SHP Food", description: "SHP Food" };
  if (lower.includes("instant")) return { value: "Instant Delivery", description: "Instant Delivery" };
  const code = raw.slice(0, 100);
  return { value: code, description: code };
}

let transportValues = null;

async function loadTransportValues() {
  if (transportValues) return transportValues;
  const data = await sapCall("GET", "/UserFieldsMD", {
    params: {
      $filter: "TableName eq 'ORDR' and Name eq 'MK_Transport'",
    },
  });
  const row = ((data && data.value) || [])[0];
  if (!row) throw new Error("ไม่พบฟิลด์ MK_Transport ใน SAP");
  const list = Array.isArray(row.ValidValuesMD) ? row.ValidValuesMD : [];
  transportValues = {
    fieldId: row.FieldID,
    values: new Set(list.map((item) => item.Value)),
    list,
  };
  return transportValues;
}

async function ensureTransportValue(choice) {
  if (!choice) return null;
  const known = await loadTransportValues();
  if (known.values.has(choice.value)) return choice.value;
  const added = { Value: choice.value, Description: choice.description || choice.value };
  await sapCall("PATCH", `/UserFieldsMD(TableName='ORDR',FieldID=${known.fieldId})`, {
    body: { ValidValuesMD: [added] },
  });
  known.list = [...known.list, added];
  known.values.add(choice.value);
  return choice.value;
}

function marketplaceFields(order) {
  const fields = {};
  const put = (key, value, max) => {
    const next = clipSap(value, max);
    if (next) fields[key] = next;
  };
  put("U_MK_OrderID", order.marketplaceOrderId || order.MarketplaceOrderId, 20);
  put("U_MK_OrderName", order.customerName || order.CustomerName, 50);
  put("U_MK_TaxID", order.taxId || order.TaxId, 13);
  put("U_MK_Address", order.shippingAddress || order.ShippingAddress, 150);
  put("U_MK_Tel", order.customerPhone || order.CustomerPhone, 15);
  put("U_MK_TrackNo", order.trackingNo || order.trackingNumber || order.TrackingNo, 30);
  const email = clipEmail(order.email || order.customerEmail || order.CustomerEmail, emailSize);
  if (email) fields.U_MK_email = email;
  put("U_MK_Remark", order.shopName || order.ShopName, 254);
  put("U_MK_OrderChanel", order.platform || order.Platform, 15);
  put("U_MK_Chanel", order.platform || order.Platform, 50);
  const payment = paymentChoice(order.paymentMethod || order.PaymentMethod);
  if (payment) fields.U_MK_Payment = payment.value;
  const carrier = transportChoice(order.shippingCarrier || order.shippingMethod || order.ShippingMethod);
  if (carrier) fields.U_MK_Transport = carrier.value;
  return fields;
}

async function ensureMarketplaceFields(order) {
  await widenEmailField();
  const fields = marketplaceFields(order);
  if (fields.U_MK_Transport) {
    const carrier = transportChoice(order.shippingCarrier || order.shippingMethod || order.ShippingMethod);
    try {
      await ensureTransportValue(carrier);
    } catch (error) {
      console.warn("SAP transport value:", error.message);
      delete fields.U_MK_Transport;
    }
  }
  if (fields.U_MK_Payment) {
    const payment = paymentChoice(order.paymentMethod || order.PaymentMethod);
    try {
      await ensurePaymentValue(payment);
    } catch (error) {
      console.warn("SAP payment value:", error.message);
      delete fields.U_MK_Payment;
    }
  }
  return fields;
}

async function patchSalesOrderFields(order) {
  const docNum = Number(order.sapDocNum || order.SapDocNum);
  const fields = await ensureMarketplaceFields(order);
  if (!docNum || !Object.keys(fields).length) return;
  const data = await sapCall("GET", "/Orders", {
    params: {
      $select: "DocEntry",
      $filter: `DocNum eq ${docNum}`,
      $top: 1,
    },
  });
  const row = ((data && data.value) || [])[0];
  if (!row || row.DocEntry == null) return;
  await sapCall("PATCH", `/Orders(${row.DocEntry})`, { body: fields });
}

async function createSalesOrder(order) {
  if (!isConfigured()) {
    return null;
  }

  const lines = (order.lines || []).filter((line) => text(line.sku));
  if (!lines.length) {
    throw new Error("ออเดอร์ไม่มีสินค้าสำหรับสร้างใน SAP");
  }

  const mapped = await resolveSalesOrderLines(order);
  if (mapped.errors.length) {
    throw new Error(mapped.errors.join(" | "));
  }

  const cardCode = await ensureCustomer(order.platform);
  const master = buildMasterIndex(await listMasterItems());
  const documentLines = [];
  for (const entry of mapped.resolved) {
    const { line, itemCode } = entry;
    const meta = master.byCode.get(itemCode);
    const gross = Math.round(Number(line.price || 0) * 100) / 100;
    const row = {
      ItemCode: itemCode,
      Quantity: Number(line.qty || 1) || 1,
      // ราคาจากแพลตฟอร์มเป็นยอดรวมภาษี 7% ให้ไปอยู่ Gross Price after Disc
      PriceAfterVAT: gross,
      UnitPrice: Math.round((gross / 1.07) * 1000000) / 1000000,
    };
    if (meta && meta.inventory) row.WarehouseCode = "ONLINE";
    documentLines.push(row);
  }

  const header = {
    CardCode: cardCode,
    NumAtCard: String(order.marketplaceOrderId).slice(0, 100),
    Comments: [order.platform, order.marketplaceOrderId].filter(Boolean).join(" ").slice(0, 254),
    ...(await ensureMarketplaceFields(order)),
  };
  const payload = {
    ...header,
    DocumentLines: documentLines,
  };
  const docDate = sapDocDate(order.orderDate || order.OrderDate);
  if (docDate) {
    payload.DocDate = docDate;
    payload.DocDueDate = docDate;
    payload.TaxDate = docDate;
  }

  const post = (body) => sapCall("POST", "/Orders", { body });
  try {
    const data = await post(payload);
    return String((data && (data.DocNum || data.DocEntry)) || "");
  } catch (error) {
    if (!payload.DocDate || !/period|posting date|locked/i.test(error.message || "")) throw error;
    const data = await post({
      ...header,
      DocumentLines: payload.DocumentLines,
    });
    return String((data && (data.DocNum || data.DocEntry)) || "");
  }
}

let mapTimer = null;
let mapRunning = false;

async function runSapMap() {
  if (mapRunning || !isConfigured()) return 0;
  mapRunning = true;
  try {
    const mapped = await mapStoredProducts();
    console.log(`SAP item map updated: ${mapped} variant(s)`);
    return mapped;
  } catch (error) {
    console.error("SAP item map failed:", error.message);
    return 0;
  } finally {
    mapRunning = false;
  }
}

function startSapMapJob() {
  if (mapTimer) return;
  if (!isConfigured()) {
    console.log("SAP item map job skipped (SAP is not configured)");
    return;
  }

  const every = 5 * 60 * 1000;
  console.log("SAP item map job started (every 5 min)");
  setTimeout(() => {
    runSapMap();
  }, 15_000);
  mapTimer = setInterval(() => {
    runSapMap();
  }, every);
  if (typeof mapTimer.unref === "function") {
    mapTimer.unref();
  }
}

async function fillOrderTransport(docNum, shippingMethod, trackingNo) {
  const number = Number(docNum);
  const fields = {};
  const choice = transportChoice(shippingMethod);
  if (choice) {
    await ensureTransportValue(choice);
    fields.U_MK_Transport = choice.value;
  }
  const track = clipSap(trackingNo, 30);
  if (track) fields.U_MK_TrackNo = track;
  if (!number || !Object.keys(fields).length) return false;
  const data = await sapCall("GET", "/Orders", {
    params: {
      $select: "DocEntry,U_MK_Transport,U_MK_TrackNo",
      $filter: `DocNum eq ${number}`,
      $top: 1,
    },
  });
  const row = ((data && data.value) || [])[0];
  if (!row || row.DocEntry == null) return false;
  if (fields.U_MK_Transport && row.U_MK_Transport === fields.U_MK_Transport) delete fields.U_MK_Transport;
  if (fields.U_MK_TrackNo && row.U_MK_TrackNo === fields.U_MK_TrackNo) delete fields.U_MK_TrackNo;
  if (!Object.keys(fields).length) return false;
  await sapCall("PATCH", `/Orders(${row.DocEntry})`, { body: fields });
  return true;
}

async function warehouseStock(itemCode, warehouseCode) {
  const data = await sapCall("GET", `/Items('${odataKey(itemCode)}')`, {
    params: { $select: "ItemCode,ItemWarehouseInfoCollection" },
  });
  const rows = (data && data.ItemWarehouseInfoCollection) || [];
  const row = rows.find((item) => String(item.WarehouseCode || "") === warehouseCode);
  if (!row) return 0;
  const onHand = Number(row.InStock != null ? row.InStock : row.OnHand) || 0;
  const committed = Number(row.Committed) || 0;
  return onHand - committed;
}

async function mapTransferSkus(platform, items) {
  const catalog = await catalogIndex();
  const errors = [];
  const mapped = [];
  for (const item of items) {
    const sku = lookupSku(item.sku);
    const match = await matchFromCatalog(catalog, platform, sku);
    if (!match.sapItemCode) {
      errors.push(catalogMissMessage(platform, sku, match));
      continue;
    }
    mapped.push({ ...item, sku, sapItemCode: match.sapItemCode });
  }
  return { mapped, errors };
}

async function createStockTransfer(doc) {
  return sapCall("POST", "/StockTransfers", { body: doc });
}

async function findStockTransfer(documentNo, numAtCard) {
  const doc = String(documentNo || "").replace(/'/g, "''");
  if (doc) {
    try {
      const byComment = await sapCall("GET", "/StockTransfers", {
        params: {
          $select: "DocEntry,DocNum,NumAtCard,Comments",
          $filter: `contains(Comments,'${doc}')`,
          $top: 1,
        },
      });
      const hit = byComment && Array.isArray(byComment.value) ? byComment.value[0] : null;
      if (hit) return hit;
    } catch (error) {
      console.error(error);
    }
  }
  const card = String(numAtCard || "").replace(/'/g, "''").slice(0, 100);
  if (!card) return null;
  const byCard = await sapCall("GET", "/StockTransfers", {
    params: {
      $select: "DocEntry,DocNum,NumAtCard",
      $filter: `NumAtCard eq '${card}'`,
      $top: 1,
    },
  });
  return byCard && Array.isArray(byCard.value) ? byCard.value[0] || null : null;
}

module.exports = {
  isConfigured,
  login,
  mapProduct,
  mapStoredProducts,
  pushProducts,
  pushStoredProducts,
  startSapMapJob,
  clearMasterCache,
  listStockItems,
  listWarehouses,
  listInventoryTransferRequests,
  createInventoryTransferRequest,
  createStockTransfer,
  findStockTransfer,
  warehouseStock,
  mapTransferSkus,
  findSalesOrder,
  deletePlaceholderItems,
  assignPlatformCatalogs,
  marketplaceFields,
  transportChoice,
  fillOrderTransport,
  patchSalesOrderFields,
  cancelSalesOrder,
  orderIsCancelled,
  createSalesOrder,
  createDelivery,
  createReturnRequest,
};
