const connectionStore = require("./connectionStore");
const tokenService = require("./tokenService");
const shopeeService = require("./shopeeService");
const tiktokService = require("./tiktokService");
const lazadaService = require("./lazadaService");

const services = {
  Shopee: shopeeService,
  TikTok: tiktokService,
  Lazada: lazadaService,
};

const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;
const DEFAULT_SKEW_MS = 60 * 60 * 1000;

let timer = null;
let running = false;

function intervalMs() {
  const raw = Number(process.env.TOKEN_REFRESH_INTERVAL_MS || DEFAULT_INTERVAL_MS);
  return Number.isFinite(raw) && raw >= 60_000 ? raw : DEFAULT_INTERVAL_MS;
}

function skewMs() {
  const raw = Number(process.env.TOKEN_REFRESH_SKEW_MS || DEFAULT_SKEW_MS);
  return Number.isFinite(raw) && raw >= 60_000 ? raw : DEFAULT_SKEW_MS;
}

async function refreshDueConnections() {
  if (running) {
    return { skipped: true, reason: "already-running" };
  }

  running = true;
  const skew = skewMs();
  const summary = { checked: 0, refreshed: 0, skipped: 0, failed: 0, errors: [] };

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
        continue;
      }

      if (!connection || !connection.refreshToken) {
        summary.skipped += 1;
        continue;
      }

      summary.checked += 1;

      if (tokenService.needsReconnect(connection)) {
        summary.skipped += 1;
        console.warn(
          `Token auto-refresh skip ${platform}: refresh token expired, reconnect required`
        );
        continue;
      }

      if (!tokenService.needsRefresh(connection.accessTokenExpireAt, skew)) {
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
        summary.errors.push(`${platform}: ${error.message}`);
        console.error(
          `Token auto-refresh failed: ${platform} -> ${error.message}`
        );
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
    `Token auto-refresh job started (every ${Math.round(every / 60000)} min, skew ${Math.round(skewMs() / 60000)} min)`
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
