
const fs = require("fs");
const path = require("path");

require("dotenv").config({
  path: path.join(__dirname, "..", ".env"),
});

const lazadaService = require("../services/marketplaces/lazadaService");

async function main() {
  const platform = process.argv[2]?.toLowerCase();
  const file = process.argv[3];

  if (!platform || !file) {
    throw new Error(
      "Usage: node scripts/import-lazada-token.js <platform> <file.json>"
    );
  }

  if (!["lazada", "tiktok", "shopee"].includes(platform)) {
    throw new Error(`Unsupported platform: ${platform}`);
  }

  const filePath = path.resolve(file);

  if (!fs.existsSync(filePath)) {
    throw new Error(`Token file not found: ${filePath}`);
  }

  const payload = JSON.parse(
    fs.readFileSync(filePath, "utf8")
  );

  let service;

  if (platform === "lazada") {
    service = lazadaService;
  }

  if (platform === "tiktok") {
    service = require("../services/marketplaces/tiktokService");
  }

  if (platform === "shopee") {
    service = require("../services/marketplaces/shopeeService");
  }

  if (typeof service.importTokenPayload !== "function") {
    throw new Error(
      `${platform}Service does not support importTokenPayload()`
    );
  }

  const saved = await service.importTokenPayload(payload);

  if (!saved || !saved.shopId) {
    throw new Error(
      "Import returned no shopId. Verify saved token and shop mapping."
    );
  }

  const rows = Array.isArray(saved.shops) && saved.shops.length ? saved.shops : [saved];
  for (const row of rows) {
    console.log(
      [
        "saved",
        platform,
        row.shopId,
        row.shopName || "-",
        row.sellerId || "-",
      ].join(" | ")
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Import failed:", error.message);
    process.exit(1);
  });
