const crypto = require("crypto");
const axios = require("axios");

const connectionStore = require("../stores/connectionStore");
const tokenService = require("../tokenService");
const {
  expiryDate,
  toDate,
  money,
  text,
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
    timeout: 30000,
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

  const profile = await fetchSellerProfile(payload.access_token);
  const mapped = mapSellerFields(payload, profile);

  await saveShopConnection({
    shopId: mapped.shopId,
    shopName: mapped.shopName,
    sellerId: mapped.sellerId,
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    accessTokenExpireAt: expiryDate(payload.expires_in || payload.expire_in),
    refreshTokenExpireAt: expiryDate(payload.refresh_expires_in),
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

function normalizeOrder(order) {
  const address = order.address_shipping || {};
  const items = Array.isArray(order.items) ? order.items : [];

  return {
    platform: "Lazada",
    marketplaceOrderId: text(order.order_id || order.order_number),
    customerName: text(address.first_name || order.customer_first_name, "-"),
    customerPhone: text(address.phone),
    shippingAddress: [address.address1, address.address2, address.city, address.address5]
      .filter(Boolean)
      .join(" "),
    orderDate: toDate(order.created_at),
    orderStatus: mapOrderStatus(order.statuses && order.statuses[0]),
    paymentMethod: text(order.payment_method),
    shippingMethod: text(order.shipping_provider_type),
    totalAmount: money(order.price),
    currency: text(order.currency, "THB"),
    lines: items.map((item) => ({
      sku: text(item.sku || item.shop_sku, "-"),
      name: text(item.name, "-"),
      qty: Number(item.quantity || 1),
      price: money(item.item_price),
    })),
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

const { resolveSyncWindow } = require("../../utils/syncWindow");

async function fetchOrders(connection, options = {}) {
  const window = resolveSyncWindow(connection, {
    maxMs: 14 * 24 * 60 * 60 * 1000,
    firstMs: 14 * 24 * 60 * 60 * 1000,
    ...options.window,
  });

  const params = {
    limit: "50",
    offset: "0",
  };

  if (window.incremental) {
    params.update_after = window.sinceLazada;
  } else {
    params.created_after = window.sinceLazada;
  }

  const data = await lazadaCall("/orders/get", params, connection.accessToken);

  const list = (data.data && data.data.orders) || data.orders || [];
  const orders = [];

  for (const row of list) {
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

    orders.push(normalizeOrder(row));
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
  ensureFreshTokens,
  fetchSellerProfile,
  refreshShopProfile,
  fetchOrders,
  fetchProducts,
  getOrders,
};
