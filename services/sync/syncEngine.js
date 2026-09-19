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
    await orderStore.setSapDoc(order.platform, order.marketplaceOrderId, null, "saved");
    return { status: "skipped" };
  }

  try {
    const docNum = await sapService.createSalesOrder(order);
    await orderStore.setSapDoc(order.platform, order.marketplaceOrderId, docNum, "sap_ok");
    return { status: "ok", docNum };
  } catch (error) {
    await orderStore.setSapDoc(order.platform, order.marketplaceOrderId, null, "sap_error");
    return { status: "error", message: publicError(error, "SAP error") };
  }
}

function sapMessage(sap) {
  if (sap.status === "ok") {
    return `ซิงก์ออเดอร์แล้ว (SAP DocNum ${sap.docNum})`;
  }
  if (sap.status === "error") {
    return `ซิงก์ออเดอร์แล้ว แต่ SAP ไม่สำเร็จ: ${sap.message || "error"}`;
  }
  return "ซิงก์ออเดอร์แล้ว (ยังไม่ได้ตั้งค่า SAP)";
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
  const start = Date.now();
  let orderCount = 0;
  let productCount = 0;
  let sapOk = 0;
  let sapError = 0;

  try {
    const ran = await tokenService.runWithFreshTokens(
      connection,
      (conn, tokenOptions) => service.ensureFreshTokens(conn, tokenOptions),
      async (fresh) => {
        let nextOrderCount = 0;
        let nextProductCount = 0;
        let nextSapOk = 0;
        let nextSapError = 0;

        const orders = await service.fetchOrders(fresh, { window: options.window });

        for (const order of orders) {
          if (!order.marketplaceOrderId) {
            continue;
          }

          await orderStore.upsertOrder(order);
          nextOrderCount += 1;

          const sap = await pushToSap(order);
          if (sap.status === "ok") {
            nextSapOk += 1;
          } else if (sap.status === "error") {
            nextSapError += 1;
          }

          await syncLogStore.writeLog({
            connectionId: connection.id,
            platform,
            syncType: "order",
            status: sap.status === "error" ? "error" : "success",
            message: sapMessage(sap),
            orderCount: 1,
            productCount: 0,
            marketplaceOrderId: order.marketplaceOrderId,
            sapDocNum: sap.docNum || null,
            errorMessage: sap.status === "error" ? sap.message : null,
          });
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

          // สินค้าปิดขาย/ถูกถอด — ลบออกจากรายการ ไม่เก็บเป็นพร้อมขายค้าง
          const st = String(product.status || "").toLowerCase();
          if (st && st !== "active" && st !== "normal" && st !== "activate") {
            await productStore.deleteProduct(product.platform, product.productId);
            continue;
          }

          await productStore.upsertProduct(product);
          keptIds.push(String(product.productId));
          nextProductCount += 1;
        }

        // รอบดึงแคตตาล็อกเต็ม: ลบสินค้าใน DB ที่ไม่มีในรายการที่ยังขาย
        if (options.forceProducts) {
          await productStore.deleteMissing(platform, keptIds);
        }

        await connectionStore.touchSync(fresh);

        const mode = window.incremental ? "เฉพาะที่เปลี่ยน" : "รอบแรก";
        const message = sapService.isConfigured()
          ? `${mode}: ออเดอร์ ${nextOrderCount} สินค้า ${nextProductCount} (SAP สำเร็จ ${nextSapOk} ล้มเหลว ${nextSapError})`
          : `${mode}: ออเดอร์ ${nextOrderCount} สินค้า ${nextProductCount}`;

        return {
          message,
          orderCount: nextOrderCount,
          productCount: nextProductCount,
          sapOk: nextSapOk,
          sapError: nextSapError,
          incremental: window.incremental,
        };
      }
    );

    orderCount = ran.result.orderCount;
    productCount = ran.result.productCount;
    sapOk = ran.result.sapOk;
    sapError = ran.result.sapError;
    const message = ran.result.message;
    const noop =
      window.incremental &&
      orderCount === 0 &&
      productCount === 0 &&
      sapError === 0;

    // มีออเดอร์แล้วเขียนทีละเลขด้านบน — เขียนสรุปเฉพาะตอนมีแต่สินค้า หรือรอบเต็มที่ไม่มีออเดอร์
    if (!noop && orderCount === 0 && productCount > 0) {
      await syncLogStore.writeLog({
        connectionId: connection.id,
        platform,
        syncType: window.incremental ? "incremental" : "full",
        status: "success",
        message,
        orderCount: 0,
        productCount,
      });
    }

    return {
      success: true,
      platform,
      incremental: window.incremental,
      noop,
      durationMs: Date.now() - start,
      orderCount,
      productCount,
      sapOk,
      sapError,
      message: noop ? "ไม่มีการเปลี่ยนแปลง" : message,
    };
  } catch (error) {
    const message = publicError(error, "ซิงก์ไม่สำเร็จ");

    await syncLogStore.writeLog({
      connectionId: connection.id,
      platform,
      syncType: window.incremental ? "incremental" : "full",
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
