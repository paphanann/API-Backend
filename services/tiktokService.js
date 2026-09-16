const crypto = require("crypto");
const axios = require("axios");

const connectionStore = require("./connectionStore");
const tokenService = require("./tokenService");
const {
  expiryDate,
  toDate,
  money,
  text,
  mapOrderStatus,
  mapProductStatus,
} = require("../utils/normalize");

function getConfig() {
  return {
    appKey: String(process.env.TIKTOK_APP_KEY || "").trim(),
    appSecret: String(process.env.TIKTOK_APP_SECRET || "").trim(),
    serviceId: String(process.env.TIKTOK_SERVICE_ID || "").trim(),
    redirectUrl:
      process.env.TIKTOK_REDIRECT_URL ||
      `http://localhost:${process.env.PORT || 3000}/api/tiktok/callback`,
    authHost:
      process.env.TIKTOK_AUTH_HOST ||
      "https://auth.tiktok-shops.com/oauth/authorize",
    tokenHost: process.env.TIKTOK_TOKEN_HOST || "https://auth.tiktok-shops.com",
    apiHost: process.env.TIKTOK_API_HOST || "https://open-api.tiktokglobalshop.com",
  };
}

function isConfigured() {
  const { appKey, appSecret } = getConfig();
  return Boolean(appKey && appSecret);
}

function buildAuthorizationUrl(state = "pass-tiktok") {
  const { appKey, appSecret, serviceId, redirectUrl } = getConfig();

  if (!appKey || !appSecret) {
    return null;
  }

  const mode = String(process.env.TIKTOK_AUTHORIZE_MODE || "app_key")
    .trim()
    .toLowerCase();

  if (mode === "service") {
    if (!serviceId) {
      return null;
    }

    return (
      "https://services.tiktokshop.com/open/authorize" +
      `?service_id=${encodeURIComponent(serviceId)}` +
      `&state=${encodeURIComponent(state)}`
    );
  }

  const params = new URLSearchParams({
    app_key: appKey,
    state,
    redirect_uri: redirectUrl,
  });

  return `https://auth.tiktok-shops.com/oauth/authorize?${params.toString()}`;
}

function sign(path, query, appSecret, body) {
  const params = { ...query };
  delete params.sign;
  delete params.access_token;
  const keys = Object.keys(params).sort();
  let raw = appSecret + path;

  for (const key of keys) {
    if (params[key] === undefined || params[key] === null) {
      continue;
    }
    raw += key + String(params[key]);
  }

  if (body) {
    raw += typeof body === "string" ? body : JSON.stringify(body);
  }

  raw += appSecret;
  return crypto.createHmac("sha256", appSecret).update(raw).digest("hex");
}

async function tiktokRequest(method, path, { accessToken, shopCipher, query = {}, body }) {
  const { appKey, appSecret, apiHost } = getConfig();
  const timestamp = String(Math.floor(Date.now() / 1000));
  const params = {
    app_key: appKey,
    timestamp,
    ...query,
  };

  if (shopCipher) {
    params.shop_cipher = shopCipher;
  }

  params.sign = sign(path, params, appSecret, body);

  const url = `${apiHost}${path}`;

  try {
    const { data } = await axios({
      method,
      url,
      params,
      data: body,
      headers: {
        "Content-Type": "application/json",
        "x-tts-access-token": accessToken,
      },
      timeout: 30000,
    });

    if (data && Number(data.code) !== 0) {
      const error = new Error(data.message || `TikTok error ${data.code}`);
      error.code = data.code;
      throw error;
    }

    return data.data || data;
  } catch (error) {
    const data = error.response && error.response.data;
    if (data && (data.message || data.code)) {
      const wrapped = new Error(data.message || `TikTok error ${data.code}`);
      wrapped.code = data.code;
      throw wrapped;
    }
    throw error;
  }
}

async function exchangeCodeForToken(code) {
  const { appKey, appSecret, tokenHost } = getConfig();
  const params = {
    app_key: appKey,
    app_secret: appSecret,
    auth_code: code,
    grant_type: "authorized_code",
  };

  let data;
  try {
    const response = await axios.get(`${tokenHost}/api/v2/token/get`, {
      params,
      timeout: 30000,
    });
    data = response.data;
  } catch (error) {
    const body = error.response && error.response.data;
    throw new Error(
      (body && (body.message || body.error)) ||
        error.message ||
        "แลก token จาก TikTok ไม่สำเร็จ"
    );
  }

  if (data && Number(data.code) !== 0) {
    const detail = data.message || data.request_id || JSON.stringify(data);
    throw new Error(`แลก token จาก TikTok ไม่สำเร็จ: ${detail}`);
  }

  return data.data || data;
}

async function refreshAccessToken(refreshToken) {
  const { appKey, appSecret, tokenHost } = getConfig();

  const { data } = await axios.get(`${tokenHost}/api/v2/token/refresh`, {
    params: {
      app_key: appKey,
      app_secret: appSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    },
    timeout: 30000,
  });

  if (data && Number(data.code) !== 0) {
    throw new Error(data.message || "รีเฟรช token TikTok ไม่สำเร็จ");
  }

  return data.data || data;
}

async function getAuthorizedShops(accessToken) {
  const data = await tiktokRequest("GET", "/authorization/202309/shops", {
    accessToken,
  });

  return (data && data.shops) || [];
}

async function saveShopConnection(fields) {
  return connectionStore.saveConnection({
    platform: "TikTok",
    ...fields,
  });
}

async function completeOAuth(query) {
  const code = text(query.code || query.auth_code);

  if (!code) {
    throw new Error("TikTok ไม่ได้ส่งรหัสอนุญาตกลับมา");
  }

  const tokens = await exchangeCodeForToken(code);
  if (!tokens || !tokens.access_token) {
    throw new Error("แลก token จาก TikTok ไม่สำเร็จ");
  }

  let shopId = text(tokens.seller_id || tokens.open_id || tokens.shop_id, "tiktok");
  let shopName = text(tokens.seller_name || tokens.shop_name);
  let shopCipher = text(tokens.shop_cipher);

  try {
    const shops = await getAuthorizedShops(tokens.access_token);
    if (shops[0]) {
      shopId = text(shops[0].id || shops[0].shop_id, shopId);
      shopName = text(shops[0].name || shops[0].shop_name, shopName);
      shopCipher = text(shops[0].cipher, shopCipher);
    }
  } catch {
    // token ยังใช้ดึงร้านไม่ได้ ก็เก็บจากข้อมูล token ไปก่อน
  }

  await saveShopConnection({
    shopId,
    shopName,
    shopCipher,
    openId: text(tokens.open_id),
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    accessTokenExpireAt: expiryDate(tokens.access_token_expire_in),
    refreshTokenExpireAt: expiryDate(tokens.refresh_token_expire_in),
  });

  return { shopId, shopName };
}

async function ensureShopCipher(connection) {
  if (connection.shopCipher) {
    return connection;
  }

  const shops = await getAuthorizedShops(connection.accessToken);
  const shop = shops[0];
  if (!shop) {
    throw new Error(
      "TikTok ไม่พบร้านที่อนุญาต กรุณากด Connect TikTok ใหม่หลังเปิด scope ใน Partner Center"
    );
  }

  const shopId = text(shop.id || shop.shop_id, connection.shopId);
  const shopName = text(shop.name || shop.shop_name, connection.shopName);
  const shopCipher = text(shop.cipher);

  if (!shopCipher) {
    throw new Error(
      "TikTok ไม่ส่ง shop_cipher — เปิดสิทธิ์ authorization.shop ใน Partner Center แล้ว Connect ใหม่"
    );
  }

  await connectionStore.updateConnectedShop("TikTok", {
    shopId,
    shopName,
    shopCipher,
  });

  return {
    ...connection,
    shopId,
    shopName,
    shopCipher,
  };
}

async function ensureFreshTokens(connection, options = {}) {
  tokenService.assertLiveToken(connection.accessToken);

  if (tokenService.needsReconnect(connection)) {
    throw tokenService.reconnectRequired();
  }

  let next = connection;
  try {
    next = await ensureShopCipher(connection);
  } catch (error) {
    // ถ้ายังไม่มี cipher จะพังตอน fetch พร้อมข้อความชัดเจน
    if (!connection.shopCipher) {
      throw error;
    }
  }

  const due = options.force || tokenService.needsRefresh(next.accessTokenExpireAt);
  if (!due) {
    return next;
  }

  if (!next.refreshToken) {
    throw tokenService.reconnectRequired();
  }

  try {
    const tokens = await refreshAccessToken(next.refreshToken);
    return tokenService.applyRefresh(next, {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      accessTokenExpireAt: expiryDate(tokens.access_token_expire_in),
      refreshTokenExpireAt: expiryDate(tokens.refresh_token_expire_in),
      shopCipher: next.shopCipher,
    });
  } catch (error) {
    if (tokenService.isRefreshRejected(error) || tokenService.isAuthError(error)) {
      throw tokenService.reconnectRequired(error);
    }
    throw error;
  }
}

function recipientAddress(order) {
  const recipient = order.recipient_address || {};
  return [recipient.full_address, recipient.district, recipient.city, recipient.region]
    .filter(Boolean)
    .join(" ");
}

function normalizeOrder(order) {
  const payment = order.payment || {};
  const items = Array.isArray(order.line_items) ? order.line_items : [];

  return {
    platform: "TikTok",
    marketplaceOrderId: text(order.id || order.order_id),
    customerName: text(
      (order.recipient_address && order.recipient_address.name) || order.buyer_nickname,
      "-"
    ),
    customerPhone: text(order.recipient_address && order.recipient_address.phone_number),
    shippingAddress: recipientAddress(order),
    orderDate: toDate(order.create_time),
    orderStatus: mapOrderStatus(order.status),
    paymentMethod: text(payment.payment_method),
    shippingMethod: text(order.delivery_option_name || order.shipping_provider),
    totalAmount: money(payment.total_amount || order.payment_amount),
    currency: text(payment.currency, "THB"),
    lines: items.map((item) => ({
      sku: text(item.seller_sku || item.sku_id || item.product_id, "-"),
      name: text(item.product_name || item.sku_name, "-"),
      qty: Number(item.quantity || 1),
      price: money(item.sale_price || item.original_price),
    })),
  };
}

function normalizeProduct(product) {
  const sku = (product.skus && product.skus[0]) || {};
  const price = sku.price && (sku.price.sale_price || sku.price.tax_exclusive_price);

  return {
    platform: "TikTok",
    productId: text(product.id, "-"),
    sku: text(sku.seller_sku || product.id, "-"),
    name: text(product.title, "-"),
    price: money(price),
    stock: Number((sku.inventory && sku.inventory[0] && sku.inventory[0].quantity) || 0),
    status: mapProductStatus(product.status),
  };
}

async function fetchOrders(connection) {
  const now = Math.floor(Date.now() / 1000);
  const from = now - 7 * 24 * 60 * 60;
  const orders = [];
  let pageToken = "";

  for (let page = 0; page < 10; page += 1) {
    // TikTok 202309: page_size / page_token ต้องอยู่ใน query ไม่ใช่ body
    const query = { page_size: 50 };
    if (pageToken) {
      query.page_token = pageToken;
    }

    const data = await tiktokRequest("POST", "/order/202309/orders/search", {
      accessToken: connection.accessToken,
      shopCipher: connection.shopCipher,
      query,
      body: {
        create_time_ge: from,
        create_time_lt: now,
      },
    });

    const list = (data && data.orders) || [];
    for (const order of list) {
      orders.push(normalizeOrder(order));
    }

    pageToken = data && data.next_page_token;
    if (!pageToken) {
      break;
    }
  }

  return orders;
}

async function fetchProducts(connection) {
  const products = [];
  let pageToken = "";

  for (let page = 0; page < 10; page += 1) {
    const query = { page_size: 50 };
    if (pageToken) {
      query.page_token = pageToken;
    }

    const data = await tiktokRequest("POST", "/product/202309/products/search", {
      accessToken: connection.accessToken,
      shopCipher: connection.shopCipher,
      query,
      body: {},
    });

    const list = (data && data.products) || [];
    for (const product of list) {
      products.push(normalizeProduct(product));
    }

    pageToken = data && data.next_page_token;
    if (!pageToken) {
      break;
    }
  }

  return products;
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
  isConfigured,
  buildAuthorizationUrl,
  exchangeCodeForToken,
  saveShopConnection,
  completeOAuth,
  ensureFreshTokens,
  fetchOrders,
  fetchProducts,
  getOrders,
};
