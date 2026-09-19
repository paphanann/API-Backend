/** Error ที่แก้ที่ config ภายนอก — ไม่ควร spam Sync Log ทุก 15 นาที */
function isStickyConfigError(message) {
  const text = String(message || "");
  return (
    /undeclared/i.test(text) ||
    /IP Address Whitelist/i.test(text) ||
    /declare all your IP/i.test(text) ||
    /invalid.?partner.?id/i.test(text) ||
    /invalid.?partner.?key/i.test(text) ||
    /app.?not.?found/i.test(text)
  );
}

function errorFingerprint(message) {
  return String(message || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180)
    .toLowerCase();
}

module.exports = {
  isStickyConfigError,
  errorFingerprint,
};
