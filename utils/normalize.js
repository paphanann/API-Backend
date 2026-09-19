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

function expiryDate(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }

  if (numeric > 1577836800) {
    return new Date(numeric * 1000);
  }

  return new Date(Date.now() + numeric * 1000);
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
  money,
  text,
  mapOrderStatus,
  mapProductStatus,
  publicError,
};
