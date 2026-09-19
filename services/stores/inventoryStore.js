const { poolPromise } = require("../../config/database");
const { ensureSchema } = require("./schema");

function skuKey(row) {
  const sku = String(row.Sku || "").trim();
  if (sku && sku !== "-") {
    return sku;
  }
  return `PID:${row.Platform}:${row.ProductId}`;
}

async function listInventory(warehouse) {
  await ensureSchema();
  const pool = await poolPromise;

  const result = await pool.request().query(`
    SELECT
      Id,
      Platform,
      ProductId,
      Sku,
      Name,
      Price,
      Stock,
      Status,
      SyncedAt
    FROM dbo.MarketplaceProduct
    ORDER BY SyncedAt DESC
  `);

  const bySku = new Map();

  for (const row of result.recordset) {
    const key = skuKey(row);
    const platform = String(row.Platform || "").trim().toLowerCase();
    const stock = Number(row.Stock);
    const qty = Number.isFinite(stock) ? stock : 0;
    const syncedAt = row.SyncedAt ? new Date(row.SyncedAt) : null;

    let item = bySku.get(key);
    if (!item) {
      item = {
        Sku: String(row.Sku || row.ProductId || "-"),
        Name: String(row.Name || "-"),
        Warehouse: "MARKETPLACE",
        Available: 0,
        Reserved: 0,
        Shopee: false,
        TikTok: false,
        Lazada: false,
        UpdatedAt: syncedAt,
        platforms: new Set(),
      };
      bySku.set(key, item);
    }

    item.Available += qty;
    if (syncedAt && (!item.UpdatedAt || syncedAt > item.UpdatedAt)) {
      item.UpdatedAt = syncedAt;
    }
    if (row.Name && (!item.Name || item.Name === "-")) {
      item.Name = String(row.Name);
    }

    if (platform === "shopee") {
      item.Shopee = true;
      item.platforms.add("Shopee");
    } else if (platform === "tiktok") {
      item.TikTok = true;
      item.platforms.add("TikTok");
    } else if (platform === "lazada") {
      item.Lazada = true;
      item.platforms.add("Lazada");
    }
  }

  let rows = [...bySku.values()].map((item) => ({
    Sku: item.Sku,
    Name: item.Name,
    Warehouse: item.Warehouse,
    Available: item.Available,
    Reserved: item.Reserved,
    Shopee: item.Shopee,
    TikTok: item.TikTok,
    Lazada: item.Lazada,
    UpdatedAt: item.UpdatedAt,
  }));

  const wh = String(warehouse || "").trim().toUpperCase();
  if (wh && wh !== "ALL" && wh !== "MARKETPLACE") {
    // กรองตามช่องทาง: Shopee / TikTok / Lazada
    rows = rows.filter((row) => {
      if (wh === "SHOPEE") return row.Shopee;
      if (wh === "TIKTOK") return row.TikTok;
      if (wh === "LAZADA") return row.Lazada;
      return row.Warehouse.toUpperCase() === wh;
    });
  }

  rows.sort((a, b) => String(a.Sku).localeCompare(String(b.Sku)));
  return rows;
}

module.exports = {
  listInventory,
};
