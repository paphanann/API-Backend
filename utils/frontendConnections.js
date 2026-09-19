/**
 * Redirect URL กลับหน้า /connections หลัง OAuth
 * @param {string} status success|error
 * @param {string} [message]
 * @param {string} [returnBase] base จาก TikTok returnUrl หรือ FRONTEND_URL
 */
function frontendConnections(status, message, returnBase) {
  const base =
    returnBase ||
    process.env.FRONTEND_URL ||
    "http://localhost:5173";
  const url = new URL(
    base.includes("/connections") ? base : `${String(base).replace(/\/$/, "")}/connections`
  );
  url.searchParams.set("status", status);
  url.searchParams.set(
    "message",
    message || (status === "success" ? "เชื่อมต่อสำเร็จ" : "")
  );
  return url.toString();
}

module.exports = { frontendConnections };
