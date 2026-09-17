const connectionStore = require("./connectionStore");
const syncEngine = require("./syncEngine");
const shopeeService = require("./shopeeService");
const tiktokService = require("./tiktokService");
const lazadaService = require("./lazadaService");
const { poolPromise } = require("../config/database");

const services = {
  Shopee: shopeeService,
  TikTok: tiktokService,
  Lazada: lazadaService,
};

// ถี่เกินไปจะทำให้ Sync Log ดูซ้ำ — ค่าเริ่มต้น 15 นาที
const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;
const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000;

let timer = null;
let running = false;

function intervalMs() {
  const raw = Number(process.env.ORDER_SYNC_INTERVAL_MS || DEFAULT_INTERVAL_MS);
  return Number.isFinite(raw) && raw >= 60_000 ? raw : DEFAULT_INTERVAL_MS;
}

function cooldownMs() {
  const raw = Number(process.env.ORDER_SYNC_COOLDOWN_MS || DEFAULT_COOLDOWN_MS);
  return Number.isFinite(raw) && raw >= 30_000 ? raw : DEFAULT_COOLDOWN_MS;
}

/** ล็อกด้วย LastSyncAt — ไม่พึ่ง SyncLog (รอบ noop ไม่เขียน log) */
async function recentlySyncedInDb(ms) {
  try {
    const pool = await poolPromise;
    const result = await pool
      .request()
      .input("seconds", Math.ceil(ms / 1000))
      .query(`
        SELECT TOP 1 ConnectionId
        FROM dbo.MarketplaceConnection
        WHERE LastSyncAt IS NOT NULL
          AND LastSyncAt >= DATEADD(SECOND, -@seconds, GETDATE())
        ORDER BY LastSyncAt DESC
      `);
    return Boolean(result.recordset && result.recordset[0]);
  } catch {
    return false;
  }
}

async function syncAllConnected(options = {}) {
  if (running) {
    return {
      skipped: true,
      reason: "already-running",
      results: [],
      message: "กำลัง sync อยู่แล้ว",
    };
  }

  if (!options.force && (await recentlySyncedInDb(cooldownMs()))) {
    return {
      skipped: true,
      reason: "cooldown",
      results: [],
      message: `เพิ่ง sync ไปแล้วภายใน ${Math.round(cooldownMs() / 60000)} นาที — ข้ามรอบนี้`,
    };
  }

  running = true;
  const summary = {
    skipped: false,
    checked: 0,
    synced: 0,
    failed: 0,
    noop: 0,
    results: [],
    errors: [],
  };

  try {
    const platforms = ["Shopee", "TikTok", "Lazada"];

    for (const platform of platforms) {
      const service = services[platform];
      if (!service || !service.isConfigured || !service.isConfigured()) {
        continue;
      }

      let connection;
      try {
        connection = await connectionStore.getConnected(platform);
      } catch (error) {
        summary.failed += 1;
        summary.errors.push(`${platform}: ${error.message}`);
        summary.results.push({
          platform,
          success: false,
          message: error.message,
        });
        continue;
      }

      if (!connection) {
        continue;
      }

      if (platform === "TikTok" && !connection.shopCipher) {
        summary.results.push({
          platform,
          success: false,
          skipped: true,
          message: "ยังไม่มี shop_cipher — ต้องเปิด scope แล้ว Connect ใหม่",
        });
        continue;
      }

      summary.checked += 1;

      try {
        const result = await syncEngine.syncPlatform(platform);
        if (result.noop) {
          summary.noop += 1;
        } else {
          summary.synced += 1;
        }
        summary.results.push(result);
        console.log(
          `Auto-sync ok: ${platform} orders=${result.orderCount} products=${result.productCount} noop=${Boolean(result.noop)}`
        );
      } catch (error) {
        summary.failed += 1;
        summary.errors.push(`${platform}: ${error.message}`);
        summary.results.push({
          platform,
          success: false,
          message: error.message,
        });
        console.error(`Auto-sync failed: ${platform} -> ${error.message}`);
      }
    }
  } finally {
    running = false;
  }

  return summary;
}

function startOrderSyncJob() {
  if (timer) {
    return;
  }

  if (String(process.env.ORDER_SYNC_AUTO || "true").toLowerCase() === "false") {
    console.log("Order auto-sync job disabled (ORDER_SYNC_AUTO=false)");
    return;
  }

  const every = intervalMs();
  console.log(
    `Order auto-sync job started (every ${Math.round(every / 60000)} min, cooldown ${Math.round(cooldownMs() / 60000)} min)`
  );

  // รอบแรกหลังบูต 45 วินาที
  setTimeout(() => {
    syncAllConnected().catch((error) => {
      console.error("Order auto-sync startup run failed:", error.message);
    });
  }, 45_000);

  timer = setInterval(() => {
    syncAllConnected().catch((error) => {
      console.error("Order auto-sync interval failed:", error.message);
    });
  }, every);

  if (typeof timer.unref === "function") {
    timer.unref();
  }
}

function stopOrderSyncJob() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = {
  startOrderSyncJob,
  stopOrderSyncJob,
  syncAllConnected,
};
