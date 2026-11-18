const orderStore = require("../stores/orderStore");
const syncLogStore = require("../stores/syncLogStore");
const sapService = require("../marketplaces/sapService");
const { recoverStoredOrder } = require("./syncEngine");

const INTERVAL_MS = 5 * 60 * 1000;
const BATCH = 30;

let timer = null;
let running = false;

async function runSapRecovery() {
  if (running) return { skipped: true, reason: "already-running" };
  if (!sapService.isConfigured()) return { skipped: true, reason: "sap-not-configured" };

  running = true;
  const summary = { checked: 0, ok: 0, failed: 0, skipped: 0 };
  try {
    const orders = await orderStore.listSapRecoveryOrders(BATCH);
    for (const order of orders) {
      summary.checked += 1;
      let result;
      try {
        result = await recoverStoredOrder(order);
      } catch (error) {
        result = { status: "error", message: error.message };
      }
      if (!result || result.status === "skipped") {
        summary.skipped += 1;
        continue;
      }
      if (result.status === "ok") {
        summary.ok += 1;
        continue;
      }
      summary.failed += 1;
      const kind = order.sapDocNum ? "Delivery" : "Sales Order";
      await syncLogStore.writeDetail({
        platform: order.platform,
        status: "error",
        message: `${kind} ไม่สำเร็จ: ${result.message || "error"}`,
        errorMessage: result.message || null,
        marketplaceOrderId: order.marketplaceOrderId,
        sapDocNum: result.docNum || order.sapDocNum || null,
      });
    }
    if (summary.checked) {
      console.log(
        `SAP recovery checked=${summary.checked} ok=${summary.ok} failed=${summary.failed} skipped=${summary.skipped}`
      );
    }
    return summary;
  } finally {
    running = false;
  }
}

function startSapRecoveryJob() {
  if (timer) {
    console.log("SAP recovery job already running — skip second start");
    return;
  }
  if (String(process.env.ENABLE_BACKGROUND_JOBS || "").toLowerCase() !== "true") return;
  if (String(process.env.SAP_RECOVERY_AUTO || "true").toLowerCase() === "false") {
    console.log("SAP recovery job disabled (SAP_RECOVERY_AUTO=false)");
    return;
  }

  console.log("SAP recovery job started (every 5 min)");
  setTimeout(() => {
    runSapRecovery().catch((error) => {
      console.error("SAP recovery startup run failed:", error.message);
    });
  }, 60_000);

  timer = setInterval(() => {
    runSapRecovery().catch((error) => {
      console.error("SAP recovery interval failed:", error.message);
    });
  }, INTERVAL_MS);

  if (typeof timer.unref === "function") timer.unref();
}

module.exports = {
  startSapRecoveryJob,
  runSapRecovery,
};
