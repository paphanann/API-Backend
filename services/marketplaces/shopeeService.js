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
  const partnerId = Number(String(process.env.SHOPEE_PARTNER_ID || "").trim());
  // ใช้ Partner Key ตามที่ Console ให้มาทั้งก้อน รวม shpk — อย่าตัดออก
  const partnerKey = String(process.env.SHOPEE_PARTNER_KEY || "").trim();
  const env = String(process.env.SHOPEE_ENV || "live").trim().toLowerCase();
  const isSandbox = env === "sandbox" || env === "test";

  return {
    partnerId,
    partnerKey,
    isSandbox,
    host:
      process.env.SHOPEE_API_HOST ||
      (isSandbox
        ? "https://openplatform.sandbox.test-stable.shopee.sg"
        : "https://partner.shopeemobile.com"),
    authHost:
      process.env.SHOPEE_AUTH_HOST ||
      (isSandbox
        ? "https://open.sandbox.test-stable.shopee.com/auth"
        : "https://open.shopee.com/auth"),
    redirectUrl:
      process.env.SHOPEE_REDIRECT_URL ||
      `http://localhost:${process.env.PORT || 3000}/api/connections/shopee/callback`,
  };
}

function isConfigured() {
  const { partnerId, partnerKey } = getConfig();
  return Boolean(partnerId && partnerKey);
}

function createSign(partnerId, partnerKey, path, timestamp, extra = "") {
  const baseString = partnerId.toString() + path + timestamp.toString() + extra;
  const sign = crypto.createHmac("sha256", partnerKey).update(baseString).digest("hex");
  return { sign };
}

function buildAuthorizationUrl() {
  const { partnerId, partnerKey, authHost, redirectUrl } = getConfig();

  if (!partnerId || !partnerKey) {
    return null;
  }

  // ใช้หน้า Authorize แบบใหม่ (ไม่ต้องเซ็น HMAC) — รองรับทั้ง Live และ Sandbox
  // Live: https://open.shopee.com/auth
  // Sandbox: https://open.sandbox.test-stable.shopee.com/auth
  const params = new URLSearchParams({
    partner_id: String(partnerId),
    auth_type: "seller",
    redirect_uri: redirectUrl,
    response_type: "code",
    state: "pass-shopee",
  });

  return `${authHost}?${params.toString()}`;
}

function signedUrl(path, { accessToken, shopId } = {}) {
  const { partnerId, partnerKey, host } = getConfig();
  const timestamp = Math.floor(Date.now() / 1000);
  const extra = accessToken ? `${accessToken}${shopId}` : "";
  const { sign } = createSign(partnerId, partnerKey, path, timestamp, extra);

  let url =
    `${host}${path}` +
    `?partner_id=${partnerId}` +
    `&timestamp=${timestamp}` +
    `&sign=${sign}`;

  if (accessToken) {
    url += `&shop_id=${shopId}&access_token=${encodeURIComponent(accessToken)}`;
  }

  return url;
}

async function shopeeRequest(method, path, { body, query, connection } = {}) {
  const url = signedUrl(path, connection);

  try {
    const { data } = await axios({
      method,
      url,
      params: query,
      data: method === "GET" ? undefined : body,
      timeout: 30000,
    });

    if (data && data.error) {
      const error = new Error(data.message || data.error);
      error.code = data.error;
      throw error;
    }

    return data;
  } catch (error) {
    const data = error.response && error.response.data;
    if (data && (data.error || data.message)) {
      const wrapped = new Error(data.message || data.error);
      wrapped.code = data.error;
      throw wrapped;
    }
    throw error;
  }
}

async function exchangeCodeForToken(code, shopId) {
  const { partnerId } = getConfig();

  return shopeeRequest("POST", "/api/v2/auth/token/get", {
    body: {
      code,
      shop_id: Number(shopId),
      partner_id: Number(partnerId),
    },
  });
}

async function refreshAccessToken(connection) {
  const { partnerId } = getConfig();

  return shopeeRequest("POST", "/api/v2/auth/access_token/get", {
    body: {
      refresh_token: connection.refreshToken,
      partner_id: Number(partnerId),
      shop_id: Number(connection.shopId),
    },
  });
}

async function getShopInfo(shopId, accessToken) {
  return shopeeRequest("GET", "/api/v2/shop/get_shop_info", {
    connection: { accessToken, shopId },
  });
}

async function saveShopConnection(fields) {
  return connectionStore.saveConnection({
    platform: "Shopee",
    ...fields,
  });
}

async function completeOAuth(query) {
  const code = text(query.code);
  const shopId = text(query.shop_id || query.shopId);
  const mainAccountId = text(query.main_account_id || query.mainAccountId);

  if (!code) {
    throw new Error("Shopee ไม่ได้ส่ง code กลับมา");
  }

  if (!shopId && !mainAccountId) {
    throw new Error("Shopee ไม่ได้ส่ง shop_id หรือ main_account_id กลับมา");
  }

  const { partnerId } = getConfig();
  const body = {
    code,
    partner_id: Number(partnerId),
  };

  if (shopId) {
    body.shop_id = Number(shopId);
  } else {
    body.main_account_id = Number(mainAccountId);
  }

  const tokens = await shopeeRequest("POST", "/api/v2/auth/token/get", { body });
  if (!tokens || !tokens.access_token) {
    throw new Error("แลก token จาก Shopee ไม่สำเร็จ");
  }

  const resolvedShopId = text(
    shopId ||
      (tokens.shop_id_list && tokens.shop_id_list[0]) ||
      tokens.shop_id ||
      mainAccountId,
    "shopee"
  );

  let shopName = null;
  try {
    const shop = await getShopInfo(resolvedShopId, tokens.access_token);
    shopName = shop && (shop.shop_name || (shop.shop_info && shop.shop_info.shop_name));
  } catch {
    shopName = null;
  }

  await saveShopConnection({
    shopId: resolvedShopId,
    shopName,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    accessTokenExpireAt: expiryDate(tokens.expire_in || tokens.expireAt),
    refreshTokenExpireAt: expiryDate(tokens.refresh_token_expire_in),
  });

  console.log(`Shopee saved MarketplaceConnection shop=${resolvedShopId} name=${shopName || "-"}`);
  return { shopId: resolvedShopId, shopName };
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
    const tokens = await refreshAccessToken(connection);
    return tokenService.applyRefresh(connection, {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      accessTokenExpireAt: expiryDate(tokens.expire_in || tokens.expireAt),
      refreshTokenExpireAt: expiryDate(tokens.refresh_token_expire_in),
    });
  } catch (error) {
    if (tokenService.isRefreshRejected(error) || tokenService.isAuthError(error)) {
      throw tokenService.reconnectRequired(error);
    }
    throw error;
  }
}

function normalizeOrder(detail) {
  const recipient = detail.recipient_address || {};
  const items = Array.isArray(detail.item_list) ? detail.item_list : [];

  return {
    platform: "Shopee",
    marketplaceOrderId: text(detail.order_sn),
    customerName: text(detail.buyer_username || recipient.name, "-"),
    customerPhone: text(recipient.phone),
    shippingAddress: [recipient.full_address, recipient.city, recipient.state]
      .filter(Boolean)
      .join(" "),
    orderDate: toDate(detail.create_time),
    orderStatus: mapOrderStatus(detail.order_status),
    paymentMethod: text(detail.payment_method),
    shippingMethod: text(detail.shipping_carrier),
    totalAmount: money(detail.total_amount),
    currency: text(detail.currency, "THB"),
    lines: items.map((item) => ({
      sku: text(item.model_sku || item.item_sku || item.item_id, "-"),
      name: text(item.item_name || item.model_name, "-"),
      qty: Number(item.model_quantity_purchased || item.quantity || 1),
      price: money(item.model_original_price || item.model_discounted_price),
    })),
  };
}

function pickShopeeImage(item) {
  const list =
    (item.image && (item.image.image_url_list || item.image.image_url)) ||
    item.image_url_list ||
    item.images ||
    (item.image && item.image.image_list) ||
    [];
  const urls = Array.isArray(list) ? list : list ? [list] : [];
  for (const first of urls) {
    if (!first) continue;
    if (typeof first === "string" && first.trim()) return first.trim();
    const url = first.image_url || first.url || first.image;
    if (url) return url;
  }

  const single =
    (typeof item.image === "string" && item.image) ||
    item.image_url ||
    item.cover_image ||
    null;
  if (single) return single;

  const ids = (item.image && item.image.image_id_list) || item.image_id_list || [];
  const id = Array.isArray(ids) ? ids[0] : null;
  if (id) return `https://cf.shopee.co.th/file/${id}`;
  return null;
}

function tierOptionLabel(tierVariation, tierIndex) {
  if (!Array.isArray(tierVariation) || !Array.isArray(tierIndex)) return "";
  const parts = [];
  for (let i = 0; i < tierIndex.length; i += 1) {
    const tier = tierVariation[i];
    const idx = tierIndex[i];
    const option =
      tier &&
      Array.isArray(tier.option_list) &&
      tier.option_list[idx] &&
      (tier.option_list[idx].option || tier.option_list[idx].name);
    if (option) parts.push(String(option));
  }
  return parts.join(" / ");
}

function normalizeProduct(item, modelsPayload = null) {
  const imageUrl = pickShopeeImage(item);
  const models = (modelsPayload && modelsPayload.model) || [];
  const tierVariation = (modelsPayload && modelsPayload.tier_variation) || [];

  const variants = models.map((model) => {
    const priceInfo = (model.price_info && model.price_info[0]) || model.price_info || {};
    const stockInfo =
      (model.stock_info_v2 &&
        model.stock_info_v2.summary_info &&
        model.stock_info_v2.summary_info.total_available_stock) ||
      (Array.isArray(model.stock_info) && model.stock_info[0] && model.stock_info[0].normal_stock) ||
      0;

    return {
      sku: text(model.model_sku, ""),
      modelId: String(model.model_id || ""),
      option: tierOptionLabel(tierVariation, model.tier_index) || text(model.model_name, ""),
      price: money(
        priceInfo.current_price ||
          priceInfo.original_price ||
          (item.price_info && item.price_info.current_price)
      ),
      stock: Number(stockInfo || 0),
      status: mapProductStatus(item.item_status),
      imageUrl,
    };
  });

  const priceFromParent = money(item.price_info && item.price_info.current_price);
  const stockFromParent = Number(
    (item.stock_info_v2 &&
      item.stock_info_v2.summary_info &&
      item.stock_info_v2.summary_info.total_available_stock) ||
      0
  );

  return {
    platform: "Shopee",
    productId: String(item.item_id),
    sku: text(item.item_sku || item.item_id, "-"),
    name: text(item.item_name, "-"),
    price: variants.length
      ? Math.min(...variants.map((v) => Number(v.price) || 0))
      : priceFromParent,
    stock: variants.length
      ? variants.reduce((sum, v) => sum + Number(v.stock || 0), 0)
      : stockFromParent,
    status: mapProductStatus(item.item_status),
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

  // รอบถัดไปใช้ update_time เพื่อจับออเดอร์ที่สถานะเปลี่ยน (ไม่ใช่แค่สร้างใหม่)
  const timeField = window.incremental ? "update_time" : "create_time";
  const orderSns = [];
  let cursor = "";

  for (let page = 0; page < 10; page += 1) {
    const query = {
      time_range_field: timeField,
      time_from: window.sinceSec,
      time_to: window.untilSec,
      page_size: 50,
    };
    if (cursor) {
      query.cursor = cursor;
    }

    const data = await shopeeRequest("GET", "/api/v2/order/get_order_list", {
      connection,
      query,
    });

    const list = (data.response && data.response.order_list) || [];
    for (const row of list) {
      if (row.order_sn) {
        orderSns.push(row.order_sn);
      }
    }

    if (!data.response || !data.response.more) {
      break;
    }

    cursor = data.response.next_cursor || "";
    if (!cursor) {
      break;
    }
  }

  const orders = [];

  for (let i = 0; i < orderSns.length; i += 50) {
    const batch = orderSns.slice(i, i + 50);
    const detail = await shopeeRequest("GET", "/api/v2/order/get_order_detail", {
      connection,
      query: {
        order_sn_list: batch.join(","),
        response_optional_fields:
          "buyer_user_name,item_list,total_amount,recipient_address,payment_method,shipping_carrier",
      },
    });

    const list = (detail.response && detail.response.order_list) || [];
    for (const row of list) {
      orders.push(normalizeOrder(row));
    }
  }

  return orders;
}

async function fetchProducts(connection, options = {}) {
  // Shopee ไม่มี filter ตาม update_time ใน get_item_list
  // รอบ incremental จึงข้ามดึงสินค้าทั้งหมด เพื่อไม่ให้ Sync = reload ทั้งแคตตาล็อก
  // (ยกเว้น forceProducts หรือยังไม่เคย sync)
  const window = resolveSyncWindow(connection, options.window || {});
  if (window.incremental && !options.forceProducts) {
    return [];
  }

  const products = [];
  let offset = 0;

  for (let page = 0; page < 10; page += 1) {
    const data = await shopeeRequest("GET", "/api/v2/product/get_item_list", {
      connection,
      query: {
        offset,
        page_size: 50,
        item_status: "NORMAL",
      },
    });

    const itemList = (data.response && data.response.item) || [];
    const ids = itemList.map((item) => item.item_id).filter(Boolean);
 
    if (ids.length) {
      const detail = await shopeeRequest("GET", "/api/v2/product/get_item_base_info", {
        connection,
        query: { item_id_list: ids.join(",") },
      });
      const items = (detail.response && detail.response.item_list) || [];
      for (const item of items) {
        let modelsPayload = null;
        if (item.has_model) {
          try {
            const models = await shopeeRequest("GET", "/api/v2/product/get_model_list", {
              connection,
              query: { item_id: item.item_id },
            });
            modelsPayload = models.response || null;
          } catch (error) {
            console.warn(`Shopee get_model_list failed for ${item.item_id}:`, error.message);
          }
        }
        products.push(normalizeProduct(item, modelsPayload));
      }
    }

    if (!data.response || !data.response.has_next_page) {
      break;
    }

    offset = data.response.next_offset || offset + 50;
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
  getShopInfo,
  saveShopConnection,
  completeOAuth,
  ensureFreshTokens,
  fetchOrders,
  fetchProducts,
  getOrders,
};
