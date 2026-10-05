const https = require("https");
const axios = require("axios");

const { text } = require("../../utils/normalize");

const PLATFORM_CARD_ENV = {
  Shopee: "SAP_CARD_CODE_SHOPEE",
  TikTok: "SAP_CARD_CODE_TIKTOK",
  Lazada: "SAP_CARD_CODE_LAZADA",
};

const PLATFORM_CARD_DEFAULT = {
  Shopee: "SHOPEE",
  TikTok: "TIKTOK",
  Lazada: "LAZADA",
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

  const itemCode = String(item.itemCode || "").trim();
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
      await http.get(path, { headers });
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
}

async function listMasterItems() {
  if (masterCache.items && Date.now() - masterCache.at < 10 * 60 * 1000) {
    return masterCache.items;
  }
  if (!isConfigured()) return [];
  if (!session) await login();

  const http = client();
  const items = [];
  let path = "/Items?$select=ItemCode,ItemName,ForeignName,InventoryItem,U_Itemcode_api&$orderby=ItemCode";

  while (path && items.length < 5000) {
    const { data } = await http.get(path, {
      headers: { ...sessionHeaders(), Prefer: "odata.maxpagesize=100" },
    });
    // เก็บทุกชิ้น — placeholder Shopee/Lazada ยังใช้จับคู่รหัส SKU ได้
    // แต่ตอนเลือกผลลัพธ์จะ prefer สินค้า inventory (tYES) ก่อน
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

function resolveSapItemCode(index, { sku, label, name }) {
  const code = String(sku || "").trim();

  const inventoryByLabel = () => {
    for (const value of [label, name]) {
      if (!value) continue;
      const found = resolveByName(index, value, { inventoryOnly: true });
      if (found) return found;
    }
    return null;
  };

  // 1) U_Itemcode_api / Itemcode_Web → รับเฉพาะ inventory จริง
  if (code && index.byApi.has(code)) {
    const hit = pickBestMeta(
      (index.byApi.get(code) || []).filter((m) => m.inventory && !m.placeholder)
    );
    if (hit) return hit.code;
  }

  // 2) ItemCode ตรง SKU → รับเฉพาะ inventory จริง
  //    (ห้ามใช้รหัส placeholder ของ Shopee/TikTok/Lazada ที่ระบบสร้างค้างไว้)
  if (code && index.byCode.has(code)) {
    const meta = index.byCode.get(code);
    if (meta.inventory && !meta.placeholder) return meta.code;
  }

  // 3) ชื่อตัวเลือก / ชื่อสินค้า → inventory เท่านั้น
  const byName = inventoryByLabel();
  if (byName) return byName;

  // ไม่พบสินค้า inventory ใน SAP = Not Mapped
  return null;
}

async function mapProduct(product) {
  const index = buildMasterIndex(await listMasterItems());
  const variants = (product.variants || []).map((variant) => {
    const option = String(variant.option || "").trim();
    const optionLabel =
      option && !["active", "inactive", "-", "null"].includes(option.toLowerCase())
        ? option
        : "";
    // ถ้า option เป็นแค่ SKU/รหัสร้าน อย่าเอาไปเทียบชื่อ — ใช้ชื่อสินค้าหลักแทน
    const optionIsCodeLike =
      !optionLabel ||
      matchKey(optionLabel) === matchKey(variant.sku) ||
      matchKey(optionLabel) === matchKey(product.sku);
    return {
      ...variant,
      ...describeSapMatch(
        resolveSapItemCode(index, {
          sku: variant.sku,
          label: optionIsCodeLike ? null : optionLabel,
          name: product.name,
        })
      ),
    };
  });

  let sapItemCode = null;
  if (!variants.length) {
    sapItemCode = resolveSapItemCode(index, {
      sku: product.sku,
      label: product.name,
      name: product.name,
    });
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
    await productStore.saveVariantMap(product.platform, product.productId, next.variants);
    mapped += next.variants.filter((variant) => variant.sapItemCode).length;
  }
  return mapped;
}

async function createSalesOrder(order) {
  if (!isConfigured()) {
    return null;
  }

  if (!session) {
    await login();
  }

  const cardCode = cardCodeFor(order.platform);
  if (!cardCode) {
    throw new Error(`ยังไม่มีรหัสลูกค้า SAP สำหรับ ${order.platform || "แพลตฟอร์มนี้"}`);
  }
  const lines = (order.lines || []).filter((line) => text(line.sku));

  if (!lines.length) {
    throw new Error("ออเดอร์ไม่มีสินค้าสำหรับสร้างใน SAP");
  }

  const payload = {
    CardCode: cardCode,
    NumAtCard: String(order.marketplaceOrderId),
    Comments: `${order.platform} ${order.marketplaceOrderId}`,
    DocumentLines: lines.map((line) => {
      const itemCode = String(line.sapItemCode || "").trim();
      if (!itemCode) {
        const sku = line.sku || "-";
        throw new Error(
          line.sapAmbiguous
            ? `SKU ${sku} ตรงกับรหัสสินค้าใน SAP มากกว่า 1 รายการ`
            : `SKU ${sku} ยังไม่ได้ผูกกับรหัสสินค้าใน SAP`
        );
      }
      return {
        ItemCode: itemCode,
        Quantity: Number(line.qty || 1),
        UnitPrice: Number(line.price || 0),
      };
    }),
  };

  const http = client();

  try {
    const { data } = await http.post("/Orders", payload, { headers: sessionHeaders() });
    return String(data.DocNum || data.DocEntry || "");
  } catch (error) {
    const status = error.response && error.response.status;
    if (status === 401 || status === 301) {
      await login();
      const { data } = await http.post("/Orders", payload, { headers: sessionHeaders() });
      return String(data.DocNum || data.DocEntry || "");
    }

    const sapMessage =
      error.response &&
      error.response.data &&
      (error.response.data.error && error.response.data.error.message && error.response.data.error.message.value);

    throw new Error(sapMessage || error.message || "สร้างใบสั่งขายใน SAP ไม่สำเร็จ");
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

module.exports = {
  isConfigured,
  login,
  mapProduct,
  mapStoredProducts,
  startSapMapJob,
  clearMasterCache,
  createSalesOrder,
};
