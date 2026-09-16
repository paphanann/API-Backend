const connectionStore = require("./connectionStore");
const orderStore = require("./orderStore");
const productStore = require("./productStore");
const syncLogStore = require("./syncLogStore");
const sapService = require("./sapService");
const shopeeService = require("./shopeeService");
const tiktokService = require("./tiktokService");
const lazadaService = require("./lazadaService");
const tokenService = require("./tokenService");
const { publicError } = require("../utils/normalize");

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

async function syncPlatform(platform) {
  const service = services[platform];

  if (!service) {
    throw new Error(`ยังไม่รองรับแพลตฟอร์ม ${platform}`);
  }

  const connection = await connectionStore.getConnected(platform);

  if (!connection) {
    throw new Error("ยังไม่ได้เชื่อมต่อร้านค้า");
  }

  const start = Date.now();
  let orderCount = 0;
  let productCount = 0;
  let sapOk = 0;
  let sapError = 0;

  try {
    const ran = await tokenService.runWithFreshTokens(
      connection,
      (conn, options) => service.ensureFreshTokens(conn, options),
      async (fresh) => {
        let nextOrderCount = 0;
        let nextProductCount = 0;
        let nextSapOk = 0;
        let nextSapError = 0;

        const orders = await service.fetchOrders(fresh);

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
        }

        const products = await service.fetchProducts(fresh);
        for (const product of products) {
          if (!product.productId) {
            continue;
          }

          await productStore.upsertProduct(product);
          nextProductCount += 1;
        }

        await connectionStore.touchSync(fresh);

        const message = sapService.isConfigured()
          ? `ออเดอร์ ${nextOrderCount} รายการ สินค้า ${nextProductCount} รายการ SAP สำเร็จ ${nextSapOk} ล้มเหลว ${nextSapError}`
          : `ออเดอร์ ${nextOrderCount} รายการ สินค้า ${nextProductCount} รายการ (ยังไม่ได้ตั้งค่า SAP)`;

        return {
          message,
          orderCount: nextOrderCount,
          productCount: nextProductCount,
          sapOk: nextSapOk,
          sapError: nextSapError,
        };
      }
    );

    orderCount = ran.result.orderCount;
    productCount = ran.result.productCount;
    sapOk = ran.result.sapOk;
    sapError = ran.result.sapError;
    const message = ran.result.message;

    await syncLogStore.writeLog({
      connectionId: connection.id,
      platform,
      syncType: "orders",
      status: sapError ? "partial" : "success",
      message,
      orderCount,
      productCount,
      errorMessage: sapError ? `SAP ไม่สำเร็จ ${sapError} รายการ` : null,
    });

    return {
      success: true,
      platform,
      durationMs: Date.now() - start,
      orderCount,
      productCount,
      sapOk,
      sapError,
      message,
    };
  } catch (error) {
    const message = publicError(error, "ซิงก์ไม่สำเร็จ");

    await syncLogStore.writeLog({
      connectionId: connection.id,
      platform,
      syncType: "orders",
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
};
