const connectionStore = require("../stores/connectionStore");
const tokenService = require("../tokenService");
const shopeeService = require("../marketplaces/shopeeService");
const tiktokService = require("../marketplaces/tiktokService");
const lazadaService = require("../marketplaces/lazadaService");

const services = {
  Shopee: shopeeService,
  TikTok: tiktokService,
  Lazada: lazadaService,
};

const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;

let timer = null;
let running = false;

function intervalMs() {
  const raw = Number(process.env.TOKEN_REFRESH_INTERVAL_MS || DEFAULT_INTERVAL_MS);
  return Number.isFinite(raw) && raw >= 60_000 ? raw : DEFAULT_INTERVAL_MS;
}

function skewFor(platform) {
  return tokenService.refreshSkewMs(platform);
}

async function refreshDueConnections() {
  if (running) {
    return { skipped: true, reason: "already-running" };
  }

  running = true;
  const summary = { checked: 0, refreshed: 0, skipped: 0, failed: 0, errors: [] };

  try {
    const platforms = ["Shopee", "TikTok", "Lazada"];

    for (const platform of platforms) {
      const service = services[platform];
      if (!service || !service.isConfigured || !service.isConfigured()) {
        continue;
      }

      let connections;
      try {
        connections = await connectionStore.listConnected(platform);
      } catch (error) {
        summary.failed += 1;
        summary.errors.push(`${platform}: ${error.message}`);
        continue;
      }

      for (const connection of connections) {
      if (!connection || !connection.refreshToken) {
        summary.skipped += 1;
        continue;
      }

      summary.checked += 1;

      if (tokenService.needsReconnect(connection)) {
        await tokenService.markTokenState({
          platform,
          shopId: connection.shopId,
          tokenStatus: "Expired",
          lastError: "Refresh Token หมดอายุ ต้องเชื่อมต่อใหม่",
        });
        summary.skipped += 1;
        console.warn(
          `Token auto-refresh skip ${platform} shop=${connection.shopId || "-"}: refresh token expired, reconnect required`
        );
        continue;
      }

      if (!tokenService.needsRefresh(connection.accessTokenExpireAt, skewFor(platform))) {
        summary.skipped += 1;
        continue;
      }

      try {
        await service.ensureFreshTokens(connection, { force: true });
        summary.refreshed += 1;
        console.log(
          `Token auto-refresh ok: ${platform} shop=${connection.shopId || "-"}`
        );
      } catch (error) {
        summary.failed += 1;
        await tokenService.markTokenState({
          platform,
          shopId: connection.shopId,
          tokenStatus: "Error",
          lastError: error.message,
        });
        summary.errors.push(`${platform} ${connection.shopId || ""}: ${error.message}`);
        console.error(
          `Token auto-refresh failed: ${platform} shop=${connection.shopId || "-"} -> ${error.message}`
        );
      }
      }
    }
  } finally {
    running = false;
  }

  return summary;
}

function startTokenRefreshJob() {
  if (timer) {
    return;
  }

  const every = intervalMs();
  console.log(
    `Token auto-refresh job started (every ${Math.round(every / 60000)} min; Shopee ≤1 h, Lazada ≤1 day, TikTok ≤1 day)`
  );

  // รอบแรกหลังบูตเล็กน้อย — ไม่บล็อก listen
  setTimeout(() => {
    refreshDueConnections().catch((error) => {
      console.error("Token auto-refresh startup run failed:", error.message);
    });
  }, 10_000);

  timer = setInterval(() => {
    refreshDueConnections().catch((error) => {
      console.error("Token auto-refresh interval failed:", error.message);
    });
  }, every);

  if (typeof timer.unref === "function") {
    timer.unref();
  }
}

function stopTokenRefreshJob() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = {
  startTokenRefreshJob,
  stopTokenRefreshJob,
  refreshDueConnections,
};
