const crypto = require("crypto");
const axios = require("axios");

const connectionStore = require("../stores/connectionStore");
const tokenService = require("../tokenService");
const { marketplaceTimeoutMs } = require("../../utils/httpTimeout");
const { mapPool } = require("../../utils/mapPool");
const {
  expiryDate,
  toDate,
  money,
  splitOrderAmounts,
  text,
  visibleText,
  mapOrderStatus,
  mapProductStatus,
} = require("../../utils/normalize");

function getConfig() {
  return {
    appKey: String(process.env.LAZADA_APP_KEY || "").trim(),
    appSecret: String(process.env.LAZADA_APP_SECRET || "").trim(),
    redirectUrl:
      process.env.LAZADA_REDIRECT_URL ||
      `http://localhost:${process.env.PORT || 3000}/api/lazada/callback`,
    authHost: String(process.env.LAZADA_AUTH_HOST || "https://auth.lazada.com").replace(/\/$/, ""),
    apiHost: process.env.LAZADA_API_HOST || "https://api.lazada.co.th/rest",
    tokenHost: process.env.LAZADA_TOKEN_HOST || "https://auth.lazada.com/rest",
  };
}

function isConfigured() {
  const { appKey, appSecret } = getConfig();
  return Boolean(appKey && appSecret);
}

function sign(path, params, appSecret) {
  const keys = Object.keys(params).sort();
  let baseString = path;

  for (const key of keys) {
    baseString += key + params[key];
  }

  return crypto.createHmac("sha256", appSecret).update(baseString).digest("hex").toUpperCase();
}

function buildAuthorizationUrl() {
  const { appKey, appSecret, redirectUrl, authHost } = getConfig();

  if (!appKey || !appSecret) {
    return null;
  }

  const authorizeHost = authHost.endsWith("/oauth/authorize")
    ? authHost
    : `${authHost}/oauth/authorize`;

  return (
    `${authorizeHost}` +
    `?response_type=code` +
    `&force_auth=true` +
    `&redirect_uri=${encodeURIComponent(redirectUrl)}` +
    `&client_id=${appKey}`
  );
}

async function lazadaCall(path, extra = {}, accessToken, host) {
  const { appKey, appSecret, apiHost } = getConfig();
  const base = host || apiHost;
  const params = {
    app_key: appKey,
    timestamp: String(Date.now()),
    sign_method: "sha256",
    ...extra,
  };

  if (accessToken) {
    params.access_token = accessToken;
  }

  params.sign = sign(path, params, appSecret);

  const { data } = await axios.get(`${base}${path}`, {
    params,
    timeout: marketplaceTimeoutMs(),
  });

  if (data && data.code && String(data.code) !== "0") {
    const error = new Error(data.message || `Lazada error ${data.code}`);
    error.code = data.code;
    throw error;
  }

  return data;
}

async function exchangeCodeForToken(code) {
  const { tokenHost } = getConfig();
  return lazadaCall("/auth/token/create", { code }, null, tokenHost);
}

async function refreshAccessToken(refreshToken) {
  const { tokenHost } = getConfig();
  return lazadaCall("/auth/token/refresh", { refresh_token: refreshToken }, null, tokenHost);
}

async function saveShopConnection(fields) {
  return connectionStore.saveConnection({
    platform: "Lazada",
    ...fields,
  });
}

function pickCountryUser(payload) {
  const list =
    (Array.isArray(payload.country_user_info) && payload.country_user_info) ||
    (Array.isArray(payload.country_user_info_list) && payload.country_user_info_list) ||
    [];

  if (!list.length) {
    return null;
  }

  const want = String(payload.country || "th").toLowerCase();
  return (
    list.find((row) => String(row.country || "").toLowerCase() === want) ||
    list.find((row) => String(row.country || "").toLowerCase() === "th") ||
    list[0]
  );
}

async function fetchSellerProfile(accessToken) {
  try {
    const data = await lazadaCall("/seller/get", {}, accessToken);
    const seller = (data && data.data) || data || {};
    return {
      shopName: text(seller.name || seller.name_company),
      sellerId: text(seller.seller_id),
      shortCode: text(seller.short_code),
      email: text(seller.email),
    };
  } catch (error) {
    console.warn("Lazada /seller/get failed:", error.message);
    return null;
  }
}

function looksLikeEmail(value) {
  return Boolean(value && String(value).includes("@"));
}

function mapSellerFields(payload, profile) {
  const countryUser = pickCountryUser(payload || {}) || {};
  const accountLogin = text(payload && payload.account);

  let numericSellerId = text(
    (profile && profile.sellerId) ||
      countryUser.seller_id ||
      (payload && payload.account_id) ||
      countryUser.user_id ||
      (payload && payload.user_id)
  );
  let shortCode = text((profile && profile.shortCode) || countryUser.short_code);
  let shopName = text(profile && profile.shopName);

  // ตรงกับโปรไฟล์ผู้ขาย Lazada:
  // ร้านค้า = Display Name, Seller ID บนหน้า PASS ใช้ Short Code (ถ้ามี)
  if (!shopName || looksLikeEmail(shopName)) {
    shopName = shortCode || (numericSellerId ? `Lazada ${numericSellerId}` : null);
    if (!shopName && accountLogin && !looksLikeEmail(accountLogin)) {
      shopName = accountLogin;
    }
  }

  const displaySellerId = shortCode || numericSellerId || null;
  const shopId = text(numericSellerId || shortCode || (payload && payload.account_id), "lazada");

  return {
    shopId,
    shopName,
    sellerId: displaySellerId,
    shortCode,
    numericSellerId,
    accountLogin,
  };
}

async function refreshShopProfile(connection) {
  if (!connection || !connection.accessToken) {
    return connection;
  }

  const profile = await fetchSellerProfile(connection.accessToken);
  if (!profile) {
    return connection;
  }

  const mapped = mapSellerFields(
    {
      account: connection.shopName,
      account_id: connection.shopId,
      country_user_info: [
        {
          seller_id: connection.openId || connection.shopId,
          short_code: null,
        },
      ],
    },
    profile
  );

  // ถ้ายังเป็นอีเมลอยู่ และได้ชื่อ/รหัสจริง ให้เขียนทับ
  const shouldUpdate =
    looksLikeEmail(connection.shopName) ||
    looksLikeEmail(connection.shopId) ||
    !connection.openId ||
    connection.shopName !== mapped.shopName ||
    String(connection.openId || "") !== String(mapped.sellerId || "");

  if (!shouldUpdate) {
    return connection;
  }

  await connectionStore.updateConnectedShop("Lazada", {
    fromShopId: connection.shopId,
    shopId: mapped.shopId,
    shopName: mapped.shopName,
    sellerId: mapped.sellerId,
    accessToken: connection.accessToken,
    refreshToken: connection.refreshToken,
    accessTokenExpireAt: connection.accessTokenExpireAt,
    refreshTokenExpireAt: connection.refreshTokenExpireAt,
  });

  console.log(
    `Lazada profile refreshed: shop=${mapped.shopName} seller=${mapped.sellerId} id=${mapped.shopId}`
  );

  return {
    ...connection,
    shopId: mapped.shopId,
    shopName: mapped.shopName,
    openId: mapped.sellerId,
  };
}

async function completeOAuth(query) {
  const code = text(query.code);

  if (!code) {
    throw new Error("Lazada ไม่ได้ส่งรหัสอนุญาตกลับมา");
  }

  const tokens = await exchangeCodeForToken(code);
  const payload = tokens && (tokens.access_token ? tokens : tokens.data);
  if (!payload || !payload.access_token) {
    throw new Error("แลก token จาก Lazada ไม่สำเร็จ");
  }

  const saved = await importTokenPayload(payload);
  return saved;
}

async function importTokenPayload(payload) {
  const body = payload && (payload.access_token ? payload : payload.data);
  if (!body || !body.access_token || !body.refresh_token) {
    throw new Error("ไฟล์โทเค็น Lazada ไม่ครบ access_token หรือ refresh_token");
  }

  const profile = await fetchSellerProfile(body.access_token);
  const mapped = mapSellerFields(body, profile);

  await saveShopConnection({
    shopId: mapped.shopId,
    shopName: mapped.shopName,
    sellerId: mapped.sellerId,
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    accessTokenExpireAt: expiryDate(body.expires_in || body.expire_in),
    refreshTokenExpireAt: expiryDate(body.refresh_expires_in),
  });

  console.log(
    `Lazada shop mapped: shopId=${mapped.shopId} sellerId=${mapped.sellerId || "-"} name=${mapped.shopName || "-"}` +
      (looksLikeEmail(mapped.accountLogin) ? ` login=${mapped.accountLogin}` : "")
  );

  return {
    shopId: mapped.shopId,
    shopName: mapped.shopName,
    sellerId: mapped.sellerId,
  };
}

async function ensureFreshTokens(connection, options = {}) {
  tokenService.assertLiveToken(connection.accessToken);

  if (tokenService.needsReconnect(connection)) {
    throw tokenService.reconnectRequired();
  }

  const due = options.force || tokenService.needsRefresh(connection.accessTokenExpireAt);
  if (!due) {
    return connection;
  }

  if (!connection.refreshToken) {
    throw tokenService.reconnectRequired();
  }

  try {
    const tokens = await refreshAccessToken(connection.refreshToken);
    const payload = tokens && (tokens.access_token ? tokens : tokens.data);
    return tokenService.applyRefresh(connection, {
      accessToken: payload && payload.access_token,
      refreshToken: payload && payload.refresh_token,
      accessTokenExpireAt: expiryDate(
        (payload && (payload.expires_in || payload.expire_in)) || tokens.expires_in
      ),
      refreshTokenExpireAt: expiryDate(
        payload && (payload.refresh_expires_in || payload.refresh_expire_in)
      ),
    });
  } catch (error) {
    if (tokenService.isRefreshRejected(error) || tokenService.isAuthError(error)) {
      throw tokenService.reconnectRequired(error);
    }
    throw error;
  }
}

function lazadaCarrier(order, items) {
  for (const item of items) {
    const provider = text(item && item.shipment_provider);
    if (provider) return provider.split(",")[0].trim();
  }
  const kind = text(order.shipping_provider_type);
  if (!kind || /standard|dropship/i.test(kind)) return null;
  return kind;
}

function lazadaTracking(items) {
  for (const item of items) {
    const code = text(item && item.tracking_code);
    if (code) return code;
  }
  return null;
}

function normalizeOrder(order) {
  const address = order.address_shipping || {};
  const items = Array.isArray(order.items) ? order.items : [];
  const lines = items.map((item) => ({
    sku: text(item.sku || item.shop_sku, "-"),
    name: text(item.name, "-"),
    qty: Number(item.quantity || 1),
    price: money(item.paid_price != null && item.paid_price !== "" ? item.paid_price : item.item_price),
  }));
  const totalAmount = money(order.price);
  const shippingKnown = order.shipping_fee != null && order.shipping_fee !== "";
  const shippingOriginal =
    order.shipping_fee_original != null && order.shipping_fee_original !== ""
      ? money(order.shipping_fee_original)
      : null;
  const amounts = splitOrderAmounts(
    lines,
    totalAmount,
    shippingKnown ? money(order.shipping_fee) : shippingOriginal
  );

  return {
    platform: "Lazada",
    marketplaceOrderId: text(order.order_id || order.order_number),
    customerName:
      [address.first_name, address.last_name].map((part) => visibleText(part)).filter(Boolean).join(" ") ||
      [order.customer_first_name, order.customer_last_name].map((part) => visibleText(part)).filter(Boolean).join(" ") ||
      "-",
    customerPhone: visibleText(address.phone || address.phone2),
    shippingAddress: [
      address.address1,
      address.address2,
      address.address3,
      address.address4,
      address.address5,
      address.city,
      address.post_code,
    ]
      .map((part) => visibleText(part))
      .filter(Boolean)
      .join(" "),
    orderDate: toDate(order.created_at),
    orderStatus: mapOrderStatus(order.statuses && order.statuses[0]),
    platformStatus: text(order.statuses && order.statuses[0]),
    paymentMethod: text(order.payment_method),
    shippingMethod: lazadaCarrier(order, items),
    trackingNo: lazadaTracking(items),
    totalAmount,
    itemAmount: amounts.itemAmount,
    discountAmount: amounts.discountAmount,
    shippingAmount: amounts.shippingAmount,
    currency: text(order.currency, "THB"),
    email: visibleText(address.email || (order.address_billing && order.address_billing.email)),
    lines,
  };
}

function pickLazadaImage(product, sku) {
  const fromProduct = Array.isArray(product.images) ? product.images[0] : null;
  const fromSku = Array.isArray(sku.Images)
    ? sku.Images[0]
    : Array.isArray(sku.images)
      ? sku.images[0]
      : null;
  const raw =
    fromProduct ||
    fromSku ||
    product.main_image ||
    product.image ||
    (typeof sku.Images === "string" ? sku.Images.split(",")[0] : null) ||
    null;
  if (!raw) return null;
  if (typeof raw === "string") return raw.trim() || null;
  return raw.url || raw.image || raw.Image || null;
}

function normalizeProduct(product) {
  const skus = Array.isArray(product.skus) ? product.skus : [];
  const imageUrl = pickLazadaImage(product, skus[0] || {});
  const variants = skus.map((sku) => ({
    sku: text(sku.SellerSku || sku.ShopSku || product.item_id, "-"),
    modelId: text(sku.SkuId || sku.sku_id || "", ""),
    option: text(
      (sku.saleProp && Object.values(sku.saleProp).join(" / ")) ||
        sku.Status ||
        sku.SellerSku ||
        "",
      ""
    ),
    price: money(sku.price || sku.special_price),
    stock: Number(sku.quantity || 0),
    status: mapProductStatus(product.status),
    imageUrl: pickLazadaImage(product, sku) || imageUrl,
  }));

  const first = skus[0] || {};
  return {
    platform: "Lazada",
    productId: text(product.item_id, "-"),
    sku: text(first.SellerSku || first.ShopSku || product.item_id, "-"),
    name: text(product.attributes && product.attributes.name, "-"),
    price: variants.length
      ? Math.min(...variants.map((v) => Number(v.price) || 0))
      : money(first.price),
    stock: variants.length
      ? variants.reduce((sum, v) => sum + Number(v.stock || 0), 0)
      : Number(first.quantity || 0),
    status: mapProductStatus(product.status),
    imageUrl,
    variants,
  };
}

const { resolveSyncWindow, timeChunks } = require("../../utils/syncWindow");

async function fetchLazadaOrderPage(connection, range, options = {}) {
  const params = {};
  if (range.incremental) {
    params.update_after = range.sinceLazada;
    params.update_before = range.untilLazada;
  } else {
    params.created_after = range.sinceLazada;
    params.created_before = range.untilLazada;
  }

  const rows = [];
  const limit = 100;
  let offset = 0;
  for (; offset < 100000; offset += limit) {
    const data = await lazadaCall(
      "/orders/get",
      { ...params, limit: String(limit), offset: String(offset) },
      connection.accessToken
    );
    const list = (data.data && data.data.orders) || data.orders || [];
    rows.push(...list);
    const total = Number(data.data && data.data.countTotal);
    if (list.length < limit) break;
    if (Number.isFinite(total) && offset + list.length >= total) break;
  }
  if (offset >= 100000) {
    console.warn(`Lazada orders hit page cap shop=${connection.shopId || "-"} offset=${offset}`);
  }

  if (options.skipDetails) {
    return rows.map((row) => normalizeOrder(row));
  }

  return mapPool(rows, 2, async (row) => {
    try {
      const full = await lazadaCall(
        "/order/get",
        { order_id: String(row.order_id) },
        connection.accessToken
      );
      const order = (full.data && (full.data.order || full.data)) || {};
      if (order.address_shipping) row.address_shipping = order.address_shipping;
      if (order.customer_first_name) row.customer_first_name = order.customer_first_name;
      if (order.customer_last_name) row.customer_last_name = order.customer_last_name;
      for (const key of ["shipping_fee", "shipping_fee_original", "price"]) {
        if (order[key] != null && order[key] !== "") row[key] = order[key];
      }
    } catch (error) {
      console.warn(`Lazada order ${row.order_id}:`, error.message);
    }

    try {
      const detail = await lazadaCall(
        "/order/items/get",
        { order_id: String(row.order_id) },
        connection.accessToken
      );
      row.items = (detail.data && detail.data) || detail.items || [];
    } catch {
      row.items = [];
    }

    return normalizeOrder(row);
  });
}

async function fetchOrders(connection, options = {}) {
  const window = resolveSyncWindow(connection, {
    maxMs: 14 * 24 * 60 * 60 * 1000,
    firstMs: 14 * 24 * 60 * 60 * 1000,
    ...options.window,
  });
  const ranges = window.incremental
    ? [window]
    : timeChunks(window.sinceMs, window.untilMs, 30 * 24 * 60 * 60 * 1000);

  const seen = new Set();
  const orders = [];
  for (const range of ranges) {
    const page = await fetchLazadaOrderPage(connection, range, options);
    console.log(`Lazada orders ${String(range.sinceLazada).slice(0, 10)} ${page.length}`);
    if (typeof options.onChunk === "function") {
      await options.onChunk(page);
    }
    for (const order of page) {
      const id = order && order.marketplaceOrderId;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      orders.push(order);
    }
  }
  return orders;
}

async function fetchProducts(connection, options = {}) {
  const window = resolveSyncWindow(connection, {
    maxMs: 30 * 24 * 60 * 60 * 1000,
    firstMs: 30 * 24 * 60 * 60 * 1000,
    ...options.window,
  });

  const params = {
    filter: "all",
    offset: "0",
    limit: "50",
  };

  // Lazada รองรับ update_after สำหรับดึงสินค้าที่เปลี่ยน (ข้ามเมื่อ forceProducts)
  if (window.incremental && !options.forceProducts) {
    params.update_after = window.sinceLazada;
  }

  const data = await lazadaCall("/products/get", params, connection.accessToken);

  const list = (data.data && data.data.products) || [];
  return list.map(normalizeProduct);
}

async function getOrders(connection) {
  const ran = await tokenService.runWithFreshTokens(
    connection,
    ensureFreshTokens,
    fetchOrders
  );
  return ran.result;
}

module.exports = {
  getConfig,
  isConfigured,
  buildAuthorizationUrl,
  exchangeCodeForToken,
  saveShopConnection,
  completeOAuth,
  importTokenPayload,
  ensureFreshTokens,
  fetchSellerProfile,
  refreshShopProfile,
  fetchOrders,
  fetchProducts,
  getOrders,
};
