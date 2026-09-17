/** หน้าต่างเวลาสำหรับ incremental sync */

const DEFAULT_LOOKBACK_MS = 30 * 60 * 1000; // กันพลาดขอบรอบก่อน
const DEFAULT_MAX_MS = 14 * 24 * 60 * 60 * 1000;
const DEFAULT_FIRST_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * ค่า DATETIME จาก SQL ที่เก็บเป็นเวลาไทย (wall clock)
 * แต่ driver อ่านเป็น UTC components — แปลงกลับเป็น epoch จริง
 */
function thaiWallToUtcMs(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) {
    return null;
  }

  return (
    Date.UTC(
      d.getUTCFullYear(),
      d.getUTCMonth(),
      d.getUTCDate(),
      d.getUTCHours(),
      d.getUTCMinutes(),
      d.getUTCSeconds()
    ) -
    7 * 60 * 60 * 1000
  );
}

function resolveSyncWindow(connection = {}, options = {}) {
  const nowMs = Date.now();
  const lookbackMs = Number(options.lookbackMs || DEFAULT_LOOKBACK_MS);
  const maxMs = Number(options.maxMs || DEFAULT_MAX_MS);
  const firstMs = Number(options.firstMs || DEFAULT_FIRST_MS);

  const lastMs = thaiWallToUtcMs(connection.lastSyncAt);
  const incremental = Number.isFinite(lastMs);

  let sinceMs = incremental ? lastMs - lookbackMs : nowMs - firstMs;

  if (nowMs - sinceMs > maxMs) {
    sinceMs = nowMs - maxMs;
  }

  if (sinceMs > nowMs - 60_000) {
    sinceMs = nowMs - 60_000;
  }

  return {
    incremental,
    sinceMs,
    untilMs: nowMs,
    sinceSec: Math.floor(sinceMs / 1000),
    untilSec: Math.floor(nowMs / 1000),
    sinceIso: new Date(sinceMs).toISOString(),
    untilIso: new Date(nowMs).toISOString(),
    // Lazada ต้องเป็น YYYY-MM-DDTHH:mm:ss±HH:MM (มี colon, ไม่มี millis)
    sinceLazada: formatLazadaDate(sinceMs),
    untilLazada: formatLazadaDate(nowMs),
  };
}

/** เช่น 2026-09-17T06:22:57+07:00 */
function formatLazadaDate(ms) {
  const thMs = Number(ms) + 7 * 60 * 60 * 1000;
  const d = new Date(thMs);
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}` +
    `+07:00`
  );
}

module.exports = {
  resolveSyncWindow,
  thaiWallToUtcMs,
};
