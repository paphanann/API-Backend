const connectionStore = require("../stores/connectionStore");
const orderStore = require("../stores/orderStore");
const productStore = require("../stores/productStore");
const syncLogStore = require("../stores/syncLogStore");
const sapService = require("../marketplaces/sapService");
const shopeeService = require("../marketplaces/shopeeService");
const tiktokService = require("../marketplaces/tiktokService");
const lazadaService = require("../marketplaces/lazadaService");
const tokenService = require("../tokenService");
const { resolveSyncWindow } = require("../../utils/syncWindow");
const { publicError } = require("../../utils/normalize");
const { startTimer } = require("../../utils/timing");

const services = {
  Shopee: shopeeService,
  TikTok: tiktokService,
  Lazada: lazadaService,
};

function sapDocArgs(order) {
  return [order.platform, order.marketplaceOrderId, order.shopId, order.companyId];
}

async function rememberSapDoc(order, docNum) {
  await orderStore.setSapDoc(order.platform, order.marketplaceOrderId, docNum, "sap_ok", order.shopId, order.companyId);
}

async function pushToSap(order) {
  const [, , shopId, companyId] = sapDocArgs(order);
  if (!sapService.isConfigured()) {
    await orderStore.setSapDoc(order.platform, order.marketplaceOrderId, null, "saved", shopId, companyId);
    return { status: "skipped" };
  }

  // อัปเดต SQL ไปแล้วก่อนถึงจุดนี้ การเปิดใบสั่งขายเป็นอีกเงื่อนไข
  const claim = await orderStore.claimSapSend(order);
  if (!claim.claimed) {
    return { status: "skipped", docNum: claim.sapDocNum || null };
  }

  try {
    const existing = await sapService.findSalesOrder(order);
    if (existing) {
      if (sapService.orderIsCancelled(order)) await sapService.cancelSalesOrder(order);
      await rememberSapDoc(order, existing);
      return { status: "ok", docNum: existing, recovered: true };
    }

    const docNum = await sapService.createSalesOrder(order);
    const savedNum = docNum || (await sapService.findSalesOrder(order));
    if (!savedNum) {
      throw new Error("SAP ไม่คืนเลขเอกสาร");
    }
    if (sapService.orderIsCancelled(order)) await sapService.cancelSalesOrder(order);
    await rememberSapDoc(order, savedNum);
    return { status: "ok", docNum: savedNum };
  } catch (error) {
    const recovered = await sapService.findSalesOrder(order).catch(() => null);
    if (recovered && sapService.orderIsCancelled(order)) {
      try {
        await sapService.cancelSalesOrder(order);
      } catch (cancelError) {
        await orderStore.setSapDoc(order.platform, order.marketplaceOrderId, null, "sap_error", shopId, companyId);
        return { status: "error", message: publicError(cancelError, "SAP error") };
      }
      await rememberSapDoc(order, recovered);
      return { status: "ok", docNum: recovered, recovered: true };
    }
    if (recovered) {
      await rememberSapDoc(order, recovered);
      return { status: "ok", docNum: recovered, recovered: true };
    }
    await orderStore.setSapDoc(order.platform, order.marketplaceOrderId, null, "sap_error", shopId, companyId);
    return { status: "error", message: publicError(error, "SAP error") };
  }
}

const SAP_SO_STATUSES = new Set(["ready_to_ship", "on_hold", "pending", "cancelled", "canceled"]);

function platformStatusKey(order) {
  return String(order.platformStatus || order.PlatformStatus || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

function allowsSalesOrder(order) {
  return SAP_SO_STATUSES.has(platformStatusKey(order));
}

const DELIVERY_STATUSES = new Set(["shipped", "in_transit"]);

function allowsDelivery(order) {
  return DELIVERY_STATUSES.has(platformStatusKey(order));
}

const RETURN_REQUEST_STATUSES = new Set(["to_return", "returned", "จัดส่งไม่สำเร็จ"]);

function allowsReturnRequest(order) {
  return RETURN_REQUEST_STATUSES.has(platformStatusKey(order));
}

function shouldCreateSalesOrder(order, result) {
  if (!allowsSalesOrder(order)) return false;
  const status = String((result && result.syncStatus) || "").toLowerCase();
  if (result && result.sapDocNum) return false;
  if (status === "sap_ok" || status === "history") return false;
  if (status === "sap_error") return true;
  const change = result && result.change;
  return change === "inserted" || change === "updated";
}

function sapDetailMessage(sap, change) {
  const verb =
    change === "inserted" ? "เพิ่มออเดอร์ใหม่" : change === "updated" ? "อัปเดตออเดอร์" : "ออเดอร์";
  if (sap.status === "ok") {
    return `${verb} แล้ว (SAP DocNum ${sap.docNum})`;
  }
  if (sap.status === "error") {
    return `${verb} แล้ว แต่ SAP ไม่สำเร็จ: ${sap.message || "error"}`;
  }
  return `${verb} แล้ว (ยังไม่ได้ตั้งค่า SAP)`;
}

function buildRunMessage({
  found,
  inserted,
  updated,
  unchanged,
  sapOk,
  sapError,
  productCount,
}) {
  if (found === 0 && productCount === 0) {
    return "ไม่พบการเปลี่ยนแปลง";
  }

  const parts = [];
  if (inserted > 0) parts.push(`เพิ่มออเดอร์ใหม่ ${inserted} รายการ`);
  if (updated > 0) parts.push(`อัปเดตออเดอร์ ${updated} รายการ`);
  if (unchanged > 0 && inserted === 0 && updated === 0) {
    parts.push("ไม่พบการเปลี่ยนแปลง");
  } else if (unchanged > 0) {
    parts.push(`ไม่เปลี่ยนแปลง ${unchanged} รายการ`);
  }
  if (productCount > 0) {
    parts.push(`อัปเดตสินค้า ${productCount} รายการ`);
  }
  if (sapService.isConfigured() && (sapOk > 0 || sapError > 0)) {
    if (sapError > 0 && sapOk > 0) {
      parts.push(`สำเร็จ ${sapOk} รายการ / ล้มเหลว ${sapError} รายการ`);
    } else if (sapError > 0) {
      parts.push(`SAP ล้มเหลว ${sapError} รายการ`);
    }
  }

  return parts.join(" · ") || "ซิงก์สำเร็จ";
}

function resolveRunStatus({ sapError, inserted, updated, productCount, sapOk }) {
  const changed = inserted + updated;
  if (sapError > 0 && (changed > 0 || productCount > 0 || sapOk > 0)) {
    return "partial";
  }
  if (sapError > 0 && changed === 0 && productCount === 0) {
    return "error";
  }
  return "success";
}

function shopCanSync(connection) {
  if (!connection || !connection.shopId || !connection.accessToken) return false;
  if (tokenService.needsReconnect(connection)) return false;
  return true;
}

async function syncConnectedShop(platform, connection, options = {}) {
  const service = services[platform];

  if (!service) {
    throw new Error(`ยังไม่รองรับแพลตฟอร์ม ${platform}`);
  }

  if (!shopCanSync(connection)) {
    throw new Error("ร้านนี้ไม่ได้เชื่อมต่อ หรือโทเค็นหมดอายุ ต้องเชื่อมต่อใหม่ก่อนซิงค์");
  }

  if (platform === "TikTok" && !connection.shopCipher) {
    throw new Error(
      `ร้าน ${connection.shopName || connection.shopId || ""} ยังไม่มี shop_cipher — ต้องเปิด scope แล้ว Connect ใหม่`
    );
  }

  const window = resolveSyncWindow(connection, options.window);
  const startedAt = Date.now();
  const syncType = window.incremental ? "incremental" : "full";

  // 1 รอบ = 1 แถวหลัก: INSERT ตอนเริ่ม แล้ว UPDATE ตอนจบ (กัน log ซ้ำ)
  const { syncRunId } = await syncLogStore.beginRun({
    connectionId: connection.id,
    platform,
    syncType,
    message: "กำลังซิงก์…",
  });

  let orderCount = 0;
  let productCount = 0;
  let sapOk = 0;
  let sapError = 0;
  let inserted = 0;
  let updated = 0;
  let unchanged = 0;

  try {
    const ran = await tokenService.runWithFreshTokens(
      connection,
      (conn, tokenOptions) => service.ensureFreshTokens(conn, tokenOptions),
      async (fresh) => {
        let nextOrderCount = 0;
        let nextProductCount = 0;
        let nextSapOk = 0;
        let nextSapError = 0;
        let nextInserted = 0;
        let nextUpdated = 0;
        let nextUnchanged = 0;

        const fetchOrdersDone = startTimer(`${platform} marketplace orders`);
        const orders = await service.fetchOrders(fresh, { window: options.window });
        fetchOrdersDone(`count=${orders.length}`);

        const shopId = connection.shopId ? String(connection.shopId) : null;
        const companyId = connection.companyId ? String(connection.companyId) : null;
        const visibleFromMs = Date.parse("2026-10-01T00:00:00.000Z");
        const visibleOrders = [];
        for (const order of orders) {
          if (!order) continue;
          const orderMs = order.orderDate ? new Date(order.orderDate).getTime() : NaN;
          if (Number.isFinite(orderMs) && orderMs < visibleFromMs) continue;
          order.shopId = shopId;
          order.shopName = connection.shopName ? String(connection.shopName) : order.shopName || null;
          order.companyId = companyId;
          visibleOrders.push(order);
        }

        const dbDone = startTimer(`${platform} database orders`);
        const saved = await orderStore.upsertOrders(visibleOrders);
        dbDone(`count=${saved.length}`);

        let sapIndex = null;
        if (sapService.isConfigured()) {
          const catalogDone = startTimer(`${platform} sap catalog`);
          sapIndex = productStore.sapCodeIndex(await productStore.listProducts(platform, shopId));
          catalogDone();
        }

        for (let index = 0; index < visibleOrders.length; index += 1) {
          const order = visibleOrders[index];
          const result = saved[index];
          if (!order.marketplaceOrderId || !result) {
            continue;
          }

          nextOrderCount += 1;

          if (result.change === "inserted") {
            nextInserted += 1;
          } else if (result.change === "updated") {
            nextUpdated += 1;
          } else {
            nextUnchanged += 1;
          }

          // สร้าง SO เมื่อสถานะเป็น READY_TO_SHIP, ON_HOLD, pending หรือ CANCELLED
          if (!shouldCreateSalesOrder(order, result)) {
            if (result.sapDocNum && sapService.orderIsCancelled(order)) {
              try {
                await sapService.cancelSalesOrder(order);
              } catch (error) {
                console.warn(`SAP cancel ${order.marketplaceOrderId}:`, error.message);
              }
            } else if (result.sapDocNum && result.change === "updated") {
              try {
                await sapService.patchSalesOrderFields({ ...order, sapDocNum: result.sapDocNum });
              } catch (error) {
                console.warn(`SAP header ${order.marketplaceOrderId}:`, error.message);
              }
            }
          } else {
            order.lines = (order.lines || []).map((line) => {
              const codes = (sapIndex && sapIndex.get(String(line.sku || "").trim())) || [];
              return {
                ...line,
                sapItemCode: codes.length === 1 ? codes[0] : null,
                sapAmbiguous: codes.length > 1,
              };
            });

            const sap = await pushToSap(order);
            if (sap.status === "ok") {
              nextSapOk += 1;
              result.sapDocNum = result.sapDocNum || sap.docNum || result.sapDocNum;
            } else if (sap.status === "error") {
              nextSapError += 1;
              await syncLogStore.writeDetail({
                connectionId: connection.id,
                platform,
                parentSyncRunId: syncRunId,
                status: "error",
                message: sapDetailMessage(sap, result.change),
                errorMessage: sap.message || null,
                marketplaceOrderId: order.marketplaceOrderId,
                sapDocNum: sap.docNum || null,
              });
            }
          }

          if (allowsDelivery(order) && result.sapDocNum && !result.deliveryDocNum && !sapService.orderIsCancelled(order)) {
            try {
              const deliveryNum = await sapService.createDelivery(order);
              if (deliveryNum) {
                await orderStore.setDeliveryDoc(
                  order.platform,
                  order.marketplaceOrderId,
                  deliveryNum,
                  order.shopId,
                  order.companyId
                );
                result.deliveryDocNum = deliveryNum;
              }
            } catch (error) {
              console.warn(`SAP delivery ${order.marketplaceOrderId}:`, error.message);
            }
          }

          if (allowsReturnRequest(order) && !result.returnRequestDocNum) {
            try {
              const returnNum = await sapService.createReturnRequest(order);
              if (returnNum) {
                await orderStore.setReturnRequestDoc(
                  order.platform,
                  order.marketplaceOrderId,
                  returnNum,
                  order.shopId,
                  order.companyId
                );
                result.returnRequestDocNum = returnNum;
              }
            } catch (error) {
              console.warn(`SAP return request ${order.marketplaceOrderId}:`, error.message);
            }
          }
        }

        const fetchProductsDone = startTimer(`${platform} marketplace products`);
        const products = await service.fetchProducts(fresh, {
          window: options.window,
          forceProducts: Boolean(options.forceProducts),
        });
        fetchProductsDone(`count=${products.length}`);
        const keptIds = [];
        for (const product of products) {
          if (!product.productId) {
            continue;
          }
          product.shopId = shopId;
          product.companyId = companyId;

          const st = String(product.status || "").toLowerCase();
          if (st && st !== "active" && st !== "normal" && st !== "activate") {
            await productStore.deleteProduct(product.platform, product.productId, shopId);
            continue;
          }

          await productStore.upsertProduct(product);
          keptIds.push(String(product.productId));
          nextProductCount += 1;
        }

        if (options.forceProducts && shopId) {
          await productStore.deleteMissing(platform, keptIds, shopId);
        }

        if (sapService.isConfigured() && keptIds.length) {
          try {
            await sapService.mapStoredProducts(platform);
          } catch (error) {
            console.error(`SAP item map failed for ${platform}:`, error.message);
          }
        }

        await connectionStore.touchSync(fresh);

        return {
          orderCount: nextOrderCount,
          productCount: nextProductCount,
          sapOk: nextSapOk,
          sapError: nextSapError,
          inserted: nextInserted,
          updated: nextUpdated,
          unchanged: nextUnchanged,
        };
      }
    );

    orderCount = ran.result.orderCount;
    productCount = ran.result.productCount;
    sapOk = ran.result.sapOk;
    sapError = ran.result.sapError;
    inserted = ran.result.inserted;
    updated = ran.result.updated;
    unchanged = ran.result.unchanged;

    const pureNoop =
      window.incremental && orderCount === 0 && productCount === 0 && sapError === 0;

    const allUnchanged =
      orderCount > 0 && inserted === 0 && updated === 0 && sapError === 0;

    const message = buildRunMessage({
      found: orderCount,
      inserted,
      updated,
      unchanged,
      sapOk,
      sapError,
      productCount,
    });

    // สำเร็จรวมถึง “ไม่พบการเปลี่ยนแปลง” — ไม่ใช้ skipped เป็นสถานะหลัก
    const status = resolveRunStatus({
      sapError,
      inserted,
      updated,
      productCount,
      sapOk,
    });

    await syncLogStore.finishRun(syncRunId, {
      status,
      message,
      errorMessage: status === "error" || status === "partial"
        ? sapError > 0
          ? `SAP ล้มเหลว ${sapError}`
          : null
        : null,
      orderCount,
      productCount,
    });

    return {
      success: status !== "error",
      platform,
      shopId: connection.shopId,
      shopName: connection.shopName,
      syncRunId,
      incremental: window.incremental,
      noop: pureNoop || allUnchanged,
      durationMs: Date.now() - startedAt,
      orderCount,
      productCount,
      sapOk,
      sapError,
      inserted,
      updated,
      unchanged,
      status,
      message,
    };
  } catch (error) {
    const message = publicError(error, "ซิงก์ไม่สำเร็จ");

    await syncLogStore.finishRun(syncRunId, {
      status: "error",
      message,
      errorMessage: message,
      orderCount,
      productCount,
    });

    throw error;
  }
}

async function syncPlatform(platform, options = {}) {
  if (options.connection) {
    return syncConnectedShop(platform, options.connection, options);
  }

  const shops = (await connectionStore.listConnected(platform)).filter(shopCanSync);
  if (!shops.length) {
    throw new Error("ยังไม่ได้เชื่อมต่อร้านค้า");
  }
  if (shops.length === 1) {
    return syncConnectedShop(platform, shops[0], options);
  }

  const results = [];
  for (const connection of shops) {
    try {
      results.push(
        await syncConnectedShop(platform, connection, {
          ...options,
          keepOtherShops: true,
        })
      );
    } catch (error) {
      results.push({
        success: false,
        platform,
        shopId: connection.shopId,
        shopName: connection.shopName,
        orderCount: 0,
        productCount: 0,
        sapOk: 0,
        sapError: 0,
        inserted: 0,
        updated: 0,
        unchanged: 0,
        message: publicError(error, "ซิงก์ไม่สำเร็จ"),
      });
    }
  }

  const sum = (key) => results.reduce((total, row) => total + Number(row[key] || 0), 0);
  const failed = results.filter((row) => !row.success);
  return {
    success: failed.length < results.length,
    platform,
    shops: results.length,
    orderCount: sum("orderCount"),
    productCount: sum("productCount"),
    sapOk: sum("sapOk"),
    sapError: sum("sapError"),
    inserted: sum("inserted"),
    updated: sum("updated"),
    unchanged: sum("unchanged"),
    message: results
      .map((row) => `${row.shopName || row.shopId || platform}: ${row.message || "ซิงก์สำเร็จ"}`)
      .join(" | "),
  };
}

async function postStoredSalesOrders(options = {}) {
  if (!sapService.isConfigured()) {
    return { total: 0, ok: 0, failed: 0, errors: ["ยังไม่ได้ตั้งค่า SAP"] };
  }

  const pending = await orderStore.listOrdersForSap();
  const orders = options.limit ? pending.slice(0, options.limit) : pending;
  const indexes = new Map();
  let ok = 0;
  let failed = 0;
  const errors = [];

  for (const order of orders) {
    const key = `${order.platform}\0${order.shopId || ""}`;
    if (!indexes.has(key)) {
      indexes.set(
        key,
        productStore.sapCodeIndex(await productStore.listProducts(order.platform, order.shopId))
      );
    }
    const sapIndex = indexes.get(key);
    order.lines = (order.lines || []).map((line) => {
      const codes = sapIndex.get(String(line.sku || "").trim()) || [];
      return {
        ...line,
        sapItemCode: codes.length === 1 ? codes[0] : null,
        sapAmbiguous: codes.length > 1,
      };
    });

    if (!allowsSalesOrder(order)) continue;
    const sap = await pushToSap(order);
    if (sap.status === "ok") {
      ok += 1;
    } else if (sap.status === "error") {
      failed += 1;
      if (errors.length < 8) {
        errors.push(`${order.platform} ${order.marketplaceOrderId}: ${sap.message || "error"}`);
      }
    }
    const done = ok + failed;
    if (done === 1 || done % 50 === 0 || done === orders.length) {
      console.log(`SAP sales orders ${done}/${orders.length} ok=${ok} failed=${failed}`);
    }
  }

  return { total: orders.length, pending: pending.length, ok, failed, errors };
}

async function resendSalesOrder(row) {
  if (row && row.SapDocNum) {
    return { status: "ok", docNum: String(row.SapDocNum), existed: true };
  }
  const order = {
    platform: row.Platform || row.platform,
    companyId: row.CompanyId || row.companyId,
    shopId: row.ShopId || row.shopId,
    shopName: row.ShopName || row.shopName,
    marketplaceOrderId: row.MarketplaceOrderId || row.marketplaceOrderId,
    customerName: row.CustomerName || row.customerName,
    customerPhone: row.CustomerPhone || row.customerPhone,
    email: row.CustomerEmail || row.customerEmail || row.email,
    trackingNo: row.TrackingNo || row.trackingNo,
    shippingAddress: row.ShippingAddress || row.shippingAddress,
    orderDate: row.OrderDate || row.orderDate,
    orderStatus: row.OrderStatus || row.orderStatus,
    platformStatus: row.PlatformStatus || row.platformStatus,
    paymentMethod: row.PaymentMethod || row.paymentMethod,
    shippingMethod: row.ShippingMethod || row.shippingMethod,
    lines: row.lines || [],
  };
  if (!allowsSalesOrder(order)) {
    return {
      status: "error",
      message: "สร้าง Sales Order ได้เมื่อสถานะเป็น READY_TO_SHIP, ON_HOLD, pending หรือ CANCELLED",
    };
  }
  return pushToSap(order);
}

module.exports = {
  syncPlatform,
  postStoredSalesOrders,
  resendSalesOrder,
  syncAllConnected: async () => {
    const { syncAllConnected } = require("./orderSyncJob");
    return syncAllConnected();
  },
};
