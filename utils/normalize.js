function toDate(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  const numeric = Number(value);
  if (Number.isFinite(numeric) && String(value).trim() !== "") {
    if (numeric > 1e12) {
      return new Date(numeric);
    }
    if (numeric > 1e9) {
      return new Date(numeric * 1000);
    }
    if (numeric > 0 && numeric < 1e8) {
      return new Date(Date.now() + numeric * 1000);
    }
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

const MAX_TOKEN_TTL_MS = 400 * 24 * 60 * 60 * 1000;
const EARLIEST_TOKEN_MS = Date.UTC(2024, 0, 1);
const UNIX_SECONDS_MIN = 1577836800;

function isPlausibleTokenExpiry(value, now = Date.now()) {
  const date = value instanceof Date ? value : new Date(value);
  const time = date.getTime();
  if (Number.isNaN(time)) return false;
  if (time < EARLIEST_TOKEN_MS) return false;
  if (time > now + MAX_TOKEN_TTL_MS) return false;
  return true;
}

function expiryDate(value, now = Date.now()) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }

  let date;
  if (numeric >= 1e12) {
    date = new Date(numeric);
  } else if (numeric > UNIX_SECONDS_MIN) {
    const asUnix = new Date(numeric * 1000);
    // บาง API ส่ง TTL เป็นมิลลิวินาที (~5e9 = ประมาณ 60 วัน)
    // ซึ่งใหญ่กว่า threshold ของ unix seconds เลยกลายเป็นปี 2127
    date = isPlausibleTokenExpiry(asUnix, now) ? asUnix : new Date(now + numeric);
  } else {
    date = new Date(now + numeric * 1000);
  }

  return isPlausibleTokenExpiry(date, now) ? date : null;
}

function repairStoredExpiry(stored, anchor, now = Date.now()) {
  if (stored == null || stored === "") return null;

  const storedDate = stored instanceof Date ? stored : new Date(stored);
  if (Number.isNaN(storedDate.getTime())) return null;
  if (isPlausibleTokenExpiry(storedDate, now)) return storedDate;

  const numeric = storedDate.getTime() / 1000;
  const anchorMs = anchor == null || anchor === "" ? now : new Date(anchor).getTime();
  if (numeric > UNIX_SECONDS_MIN && numeric < 1e11 && Number.isFinite(anchorMs)) {
    const repaired = new Date(anchorMs + numeric);
    if (isPlausibleTokenExpiry(repaired, now)) return repaired;
  }

  return null;
}

function money(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function text(value, fallback = null) {
  if (value === undefined || value === null) {
    return fallback;
  }

  const trimmed = String(value).trim();
  return trimmed ? trimmed : fallback;
}

function mapOrderStatus(raw) {
  const value = String(raw || "").toLowerCase();

  if (
    value.includes("cancel") ||
    value.includes("void") ||
    value.includes("in_cancel")
  ) {
    return "cancelled";
  }

  if (
    value.includes("complete") ||
    value.includes("deliver") ||
    value.includes("shipped") ||
    value.includes("success") ||
    value.includes("paid") ||
    value.includes("ready_to_ship") ||
    value.includes("processed") ||
    value.includes("awaiting_collection") ||
    value.includes("in_transit")
  ) {
    return "success";
  }

  return "pending";
}

function mapProductStatus(raw) {
  const value = String(raw || "")
    .toLowerCase()
    .replace(/[\s-]+/g, "_");

  if (
    value.includes("draft") ||
    value.includes("pending") ||
    value.includes("review")
  ) {
    return "draft";
  }

  // TikTok: PLATFORM_DEACTIVATED / SELLER_DEACTIVATED / FREEZE / DELETED
  // Shopee/Lazada: inactive, banned, deleted, unlist, etc.
  if (
    value.includes("inactive") ||
    value.includes("deactivat") ||
    value.includes("disable") ||
    value.includes("banned") ||
    value.includes("suspend") ||
    value.includes("freeze") ||
    value.includes("delete") ||
    value.includes("unlist") ||
    value === "off" ||
    value.includes("not_for_sale") ||
    value.includes("platform_deactivated") ||
    value.includes("seller_deactivated")
  ) {
    return "inactive";
  }

  // TikTok live listing
  if (value === "activate" || value === "active" || value.includes("normal")) {
    return "active";
  }

  return "active";
}

function publicError(error, fallback) {
  const message = text(error && error.message, fallback || "เกิดข้อผิดพลาด");
  return message
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, "[hidden]")
    .replace(
      /(access_token|refresh_token|partner_key|app_secret|client_secret)\s*[:=]\s*\S+/gi,
      "$1=[hidden]"
    );
}

module.exports = {
  toDate,
  expiryDate,
  isPlausibleTokenExpiry,
  repairStoredExpiry,
  money,
  text,
  mapOrderStatus,
  mapProductStatus,
  publicError,
};
