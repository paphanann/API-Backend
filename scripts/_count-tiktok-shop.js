require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const { poolPromise } = require("../config/database");
const connectionStore = require("../services/stores/connectionStore");
const orderStore = require("../services/stores/orderStore");
const productStore = require("../services/stores/productStore");
const lazadaService = require("../services/marketplaces/lazadaService");
const shopeeService = require("../services/marketplaces/shopeeService");
const tiktokService = require("../services/marketplaces/tiktokService");

const services = {
  Lazada: lazadaService,
  Shopee: shopeeService,
  TikTok: tiktokService,
};

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : "";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function markHistory(platform, shopId, companyId, orderIds) {
  const ids = [...new Set(orderIds.filter(Boolean).map(String))];
  if (!ids.length || !shopId) return;
  const pool = await poolPromise;
  for (let start = 0; start < ids.length; start += 400) {
    const slice = ids.slice(start, start + 400);
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const request = pool.request();
      request.input("platform", platform);
      request.input("companyId", companyId ? String(companyId) : null);
      request.input("shopId", String(shopId));
      const params = slice.map((id, index) => {
        const name = `id${index}`;
        request.input(name, id);
        return `@${name}`;
      });
      try {
        await request.query(`
          UPDATE dbo.MarketplaceOrder
          SET SyncStatus = N'history', LastSyncedAt = GETDATE()
          WHERE Platform = @platform
            AND ShopId = @shopId
            AND CompanyId = @companyId
            AND (SapDocNum IS NULL OR SapDocNum = N'')
            AND MarketplaceOrderId IN (${params.join(",")})
        `);
        break;
      } catch (error) {
        if (!/deadlock/i.test(error.message) || attempt === 5) throw error;
        await sleep(400 * attempt);
      }
    }
  }
}

(async () => {
  const requested = process.argv.slice(2).filter((arg) => !arg.startsWith("--") && arg !== argValue("--since") && arg !== argValue("--until") && arg !== argValue("--shop"));
  const platforms = requested.length ? requested : ["Lazada", "Shopee", "TikTok"];
  const sinceText = argValue("--since");
  const untilText = argValue("--until");
  const onlyShop = argValue("--shop");
  const withProducts = process.argv.includes("--products");
  const windowOverride = sinceText
    ? {
        sinceMs: Date.parse(sinceText),
        untilMs: untilText ? Date.parse(untilText) : Date.now(),
      }
    : { fullHistory: true };

  for (const platform of platforms) {
  const service = services[platform];
  if (!service) throw new Error(`ไม่รองรับ ${platform}`);

  const shops = (await connectionStore.listConnected(platform)).filter(
    (shop) => !onlyShop || String(shop.shopId) === onlyShop
  );
  for (const shop of shops) {
    let fetched = 0;
    let inserted = 0;
    try {
      const fresh = await service.ensureFreshTokens(shop);
      if (withProducts && service.fetchProducts) {
        const products = await service.fetchProducts(fresh, { forceProducts: true });
        for (const product of products) {
          product.shopId = shop.shopId ? String(shop.shopId) : null;
          product.companyId = shop.companyId ? String(shop.companyId) : null;
          await productStore.upsertProduct(product);
        }
        console.log(
          [platform, shop.shopName || "-", shop.shopId, "products", products.length].join(" | ")
        );
      }
      await service.fetchOrders(fresh, {
        window: windowOverride,
        skipDetails: platform === "Lazada" || platform === "Shopee",
        onChunk: async (page) => {
          const orders = page.filter((order) => order && order.marketplaceOrderId);
          for (const order of orders) {
            order.shopId = shop.shopId ? String(shop.shopId) : null;
            order.companyId = shop.companyId ? String(shop.companyId) : null;
            order.syncStatus = "history";
          }
          if (!orders.length) return;
          let saved;
          for (let attempt = 1; attempt <= 5; attempt += 1) {
            try {
              saved = await orderStore.upsertOrders(orders);
              break;
            } catch (error) {
              if (!/deadlock/i.test(error.message) || attempt === 5) throw error;
              await sleep(400 * attempt);
            }
          }
          fetched += orders.length;
          const freshIds = [];
          for (let i = 0; i < orders.length; i += 1) {
            const result = saved[i];
            if (!result || result.change !== "inserted") continue;
            inserted += 1;
            freshIds.push(orders[i].marketplaceOrderId);
          }
          await markHistory(platform, shop.shopId, shop.companyId, freshIds);
        },
      });
      console.log(
        [platform, shop.shopName || "-", shop.shopId, "fetched", fetched, "new", inserted].join(" | ")
      );
    } catch (error) {
      console.error(
        [platform, shop.shopName || "-", shop.shopId, "stopped", fetched, error.message].join(" | ")
      );
    }
  }
  }
  process.exit(0);
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
