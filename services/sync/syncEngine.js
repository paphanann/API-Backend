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

const services = {
  Shopee: shopeeService,
  TikTok: tiktokService,
  Lazada: lazadaService,
};

async function pushToSap(order) {
  if (!sapService.isConfigured()) {
    await orderStore.setSapDoc(order.platform, order.marketplaceOrderId, null, "saved", order.shopId);
    return { status: "skipped" };
  }

  try {
    const docNum = await sapService.createSalesOrder(order);
    await orderStore.setSapDoc(order.platform, order.marketplaceOrderId, docNum, "sap_ok", order.shopId);
    return { status: "ok", docNum };
  } catch (error) {
    await orderStore.setSapDoc(order.platform, order.marketplaceOrderId, null, "sap_error", order.shopId);
    return { status: "error", message: publicError(error, "SAP error") };
  }
}

function shouldCreateSalesOrder(order, result) {
  if (result && result.sapDocNum) {
    return false;
  }
  return String(order.orderStatus || "").toLowerCase() !== "cancelled";
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

async function syncPlatform(platform, options = {}) {
  const service = services[platform];

  if (!service) {
    throw new Error(`ยังไม่รองรับแพลตฟอร์ม ${platform}`);
  }

  const connection = await connectionStore.getConnected(platform);

  if (!connection) {
    throw new Error("ยังไม่ได้เชื่อมต่อร้านค้า");
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

        const orders = await service.fetchOrders(fresh, { window: options.window });

        for (const order of orders) {
          if (!order.marketplaceOrderId) {
            continue;
          }

          order.shopId = connection.shopId ? String(connection.shopId) : null;
          const result = await orderStore.upsertOrder(order);
          nextOrderCount += 1;

          if (result.change === "inserted") {
            nextInserted += 1;
          } else if (result.change === "updated") {
            nextUpdated += 1;
          } else {
            nextUnchanged += 1;
          }

          // ใบ SO ออกตอนมีออเดอร์ ไม่รอส่งของหรือเก็บเงิน
          if (!shouldCreateSalesOrder(order, result)) {
            continue;
          }

          order.lines = await Promise.all(
            (order.lines || []).map(async (line) => {
              const codes = await productStore.sapCodesForSku(order.platform, line.sku);
              return {
                ...line,
                sapItemCode: codes.length === 1 ? codes[0] : null,
                sapAmbiguous: codes.length > 1,
              };
            })
          );

          const sap = await pushToSap(order);
          if (sap.status === "ok") {
            nextSapOk += 1;
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

        const products = await service.fetchProducts(fresh, {
          window: options.window,
          forceProducts: Boolean(options.forceProducts),
        });
        const keptIds = [];
        for (const product of products) {
          if (!product.productId) {
            continue;
          }

          const st = String(product.status || "").toLowerCase();
          if (st && st !== "active" && st !== "normal" && st !== "activate") {
            await productStore.deleteProduct(product.platform, product.productId);
            continue;
          }

          await productStore.upsertProduct(product);
          keptIds.push(String(product.productId));
          nextProductCount += 1;
        }

        if (options.forceProducts) {
          await productStore.deleteMissing(platform, keptIds);
        }

        if (sapService.isConfigured()) {
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

module.exports = {
  syncPlatform,
  syncAllConnected: async () => {
    const { syncAllConnected } = require("./orderSyncJob");
    return syncAllConnected();
  },
};
