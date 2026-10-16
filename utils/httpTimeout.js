/** Marketplace HTTP timeout. ตั้ง MARKETPLACE_HTTP_TIMEOUT_MS ได้ (ค่าเริ่ม 8000) */
function marketplaceTimeoutMs() {
  const raw = Number(process.env.MARKETPLACE_HTTP_TIMEOUT_MS || 8000);
  if (!Number.isFinite(raw)) return 8000;
  return Math.min(15000, Math.max(3000, Math.round(raw)));
}

module.exports = {
  marketplaceTimeoutMs,
};
