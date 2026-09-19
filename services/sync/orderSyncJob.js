const connectionStore = require("../stores/connectionStore");
const syncEngine = require("./syncEngine");
const syncLogStore = require("../stores/syncLogStore");
const shopeeService = require("../marketplaces/shopeeService");
const tiktokService = require("../marketplaces/tiktokService");
const lazadaService = require("../marketplaces/lazadaService");
const { poolPromise } = require("../../config/database");
const { isStickyConfigError } = require("../../utils/syncErrors");

const services = {
  Shopee: shopeeService,
  TikTok: tiktokService,
  Lazada: lazadaService,
};

const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;
const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000;
const DEFAULT_STICKY_BACKOFF_MS = 6 * 60 * 60 * 1000;

let timer = null;
let running = false;
/** @type {Map<string, { until: number, reason: string }>} */
const stickyBackoff = new Map();

function intervalMs() {
  const raw = Number(process.env.ORDER_SYNC_INTERVAL_MS || DEFAULT_INTERVAL_MS);
  return Number.isFinite(raw) && raw >= 60_000 ? raw : DEFAULT_INTERVAL_MS;
}

function cooldownMs() {
  const raw = Number(process.env.ORDER_SYNC_COOLDOWN_MS || DEFAULT_COOLDOWN_MS);
  return Number.isFinite(raw) && raw >= 30_000 ? raw : DEFAULT_COOLDOWN_MS;
}

function stickyBackoffMs() {
  const raw = Number(process.env.SYNC_STICKY_BACKOFF_MS || DEFAULT_STICKY_BACKOFF_MS);
  return Number.isFinite(raw) && raw >= 60_000 ? raw : DEFAULT_STICKY_BACKOFF_MS;
}

function clearStickyBackoff(platform) {
  stickyBackoff.delete(platform);
}

function armStickyBackoff(platform, reason) {
  const until = Date.now() + stickyBackoffMs();
  stickyBackoff.set(platform, { until, reason: String(reason || "").slice(0, 200) });
  console.warn(
    `Auto-sync backoff ${platform} until ${new Date(until).toISOString()} (${Math.round(stickyBackoffMs() / 3600000)}h) — ${reason}`
  );
}

function stickyBlocked(platform) {
  const row = stickyBackoff.get(platform);
  if (!row) return null;
  if (Date.now() >= row.until) {
    stickyBackoff.delete(platform);
    return null;
  }
  return row;
}

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
    deferred: 0,
    results: [],
    errors: [],
  };

  try {
    for (const platform of ["Shopee", "TikTok", "Lazada"]) {
      const service = services[platform];
      if (!service || typeof service.isConfigured !== "function" || !service.isConfigured()) {
        continue;
      }

      if (!options.force) {
        const blocked = stickyBlocked(platform);
        if (blocked) {
          summary.deferred += 1;
          summary.results.push({
            platform,
            success: false,
            skipped: true,
            deferred: true,
            message: `ข้ามชั่วคราว (config error): ${blocked.reason}`,
          });
          console.log(
            `Auto-sync deferred: ${platform} until ${new Date(blocked.until).toISOString()}`
          );
          continue;
        }
      } else {
        clearStickyBackoff(platform);
      }

      let connection;
      try {
        connection = await connectionStore.getConnected(platform);
      } catch (error) {
        summary.failed += 1;
        summary.errors.push(`${platform}: ${error.message}`);
        summary.results.push({ platform, success: false, message: error.message });
        continue;
      }

      if (!connection) continue;

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
        const result = await syncEngine.syncPlatform(platform, {
          forceProducts: Boolean(options.forceProducts),
        });
        clearStickyBackoff(platform);
        if (result.noop) summary.noop += 1;
        else summary.synced += 1;
        summary.results.push(result);
        console.log(
          `Auto-sync ok: ${platform} orders=${result.orderCount} products=${result.productCount} noop=${Boolean(result.noop)}`
        );
      } catch (error) {
        summary.failed += 1;
        summary.errors.push(`${platform}: ${error.message}`);
        summary.results.push({ platform, success: false, message: error.message });
        console.error(`Auto-sync failed: ${platform} -> ${error.message}`);

        if (isStickyConfigError(error.message)) {
          armStickyBackoff(platform, error.message);
        }
      }
    }
  } finally {
    running = false;
  }

  return summary;
}

function startOrderSyncJob() {
  if (timer) return;

  if (String(process.env.ORDER_SYNC_AUTO || "true").toLowerCase() === "false") {
    console.log("Order auto-sync job disabled (ORDER_SYNC_AUTO=false)");
    return;
  }

  const every = intervalMs();
  console.log(
    `Order auto-sync job started (every ${Math.round(every / 60000)} min, cooldown ${Math.round(cooldownMs() / 60000)} min, sticky backoff ${Math.round(stickyBackoffMs() / 3600000)}h)`
  );

  setTimeout(() => {
    syncLogStore
      .collapseDuplicateErrors()
      .then((deleted) => {
        if (deleted > 0) {
          console.log(`Collapsed ${deleted} duplicate SyncLog error row(s)`);
        }
      })
      .catch((error) => {
        console.warn("collapseDuplicateErrors failed:", error.message);
      })
      .finally(() => {
        syncAllConnected().catch((error) => {
          console.error("Order auto-sync startup run failed:", error.message);
        });
      });
  }, 45_000);

  timer = setInterval(() => {
    syncAllConnected().catch((error) => {
      console.error("Order auto-sync interval failed:", error.message);
    });
  }, every);

  if (typeof timer.unref === "function") timer.unref();
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
  clearStickyBackoff,
};
