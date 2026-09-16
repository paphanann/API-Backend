const PLATFORM_MAP = {
  shopee: "Shopee",
  tiktok: "TikTok",
  tiktokshop: "TikTok",
  lazada: "Lazada",
  sap: "SAP",
};

function normalizePlatform(value) {
  if (!value) {
    return value;
  }

  const key = String(value).trim().toLowerCase();
  return PLATFORM_MAP[key] || value;
}

module.exports = {
  normalizePlatform,
};
