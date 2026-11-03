const crypto = require("crypto");

function authSecret() {
  return String(process.env.AUTH_SECRET || process.env.TOKEN_ENCRYPTION_KEY || "").trim();
}

function signToken(payload, ttlSec = 12 * 60 * 60) {
  const key = authSecret();
  if (!key) {
    throw new Error("AUTH_SECRET missing");
  }
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(
    JSON.stringify({
      ...payload,
      exp: Math.floor(Date.now() / 1000) + ttlSec,
    })
  ).toString("base64url");
  const sig = crypto.createHmac("sha256", key).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${sig}`;
}

function verifyToken(token) {
  const key = authSecret();
  if (!key || !token) return null;
  const parts = String(token).split(".");
  if (parts.length !== 3) return null;
  const expected = crypto.createHmac("sha256", key).update(`${parts[0]}.${parts[1]}`).digest("base64url");
  const left = Buffer.from(expected);
  const right = Buffer.from(parts[2]);
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!payload || typeof payload.exp !== "number" || payload.exp < Math.floor(Date.now() / 1000)) {
    return null;
  }
  return payload;
}

function isPublic(req) {
  const path = req.path || "";
  if (req.method === "POST" && path === "/api/auth/login") return true;
  if (req.method === "GET" && (path === "/" || path === "/api/health")) return true;
  if (req.method === "GET" && /\/callback$/i.test(path)) return true;
  if (req.method === "GET" && /\/connect$/i.test(path)) return true;
  if (req.method === "GET" && path === "/api/products/image") return true;
  return false;
}

function isStaffOnly(req) {
  const path = req.path || "";
  if (path.startsWith("/api/settings") || path.startsWith("/api/users") || path.startsWith("/api/sync")) {
    return true;
  }
  if (path.startsWith("/api/connections") && req.method !== "GET") return true;
  return false;
}

function requireAuth(req, res, next) {
  if (!req.path.startsWith("/api/") || isPublic(req)) return next();
  const header = String(req.headers.authorization || "");
  const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  const user = verifyToken(token);
  if (!user) {
    return res.status(401).json({ message: "กรุณาเข้าสู่ระบบ" });
  }
  req.user = user;
  if (isStaffOnly(req) && String(user.role || "").trim().toLowerCase() === "user") {
    return res.status(403).json({ message: "ไม่มีสิทธิ์ใช้งานส่วนนี้" });
  }
  return next();
}

module.exports = {
  signToken,
  verifyToken,
  requireAuth,
};
