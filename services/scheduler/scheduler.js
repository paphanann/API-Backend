const cron = require("node-cron");

const {
  getConnectedMarketplaces
} = require("../repositories/marketplaceConnectionRepository");

const {
  syncOrders
} = require("../services/orderSyncService");

function startMarketplaceScheduler() {

  // ทุก 5 นาที
  cron.schedule("*/5 * * * *", async () => {

    console.log("เริ่ม Auto Sync Order");

    try {

      const connections =
        await getConnectedMarketplaces();

      for (const connection of connections) {

        try {

          await syncOrders(connection);

        } catch (error) {

          console.error(
            `Sync ${connection.Platform} failed`,
            error.message
          );

        }

      }

    } catch (error) {

      console.error(
        "Auto Sync Error:",
        error.message
      );

    }

  });

}

module.exports = {
  startMarketplaceScheduler
};