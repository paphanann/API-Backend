const express = require("express");
const crypto = require("crypto");

const tiktokService = require("../../services/marketplaces/tiktokService");
const { publicError } = require("../../utils/normalize");
const { frontendConnections } = require("../../utils/frontendConnections");

const router = express.Router();

// เก็บ returnUrl ชั่วคราวตาม state — เพราะ TikTok callback ไม่ส่งพอร์ตหน้าเว็บกลับมา
const pendingReturns = new Map();

function cleanupPending() {
  const now = Date.now();
  for (const [key, value] of pendingReturns.entries()) {
    if (!value || !value.createdAt || now - value.createdAt > 30 * 60 * 1000) {
      pendingReturns.delete(key);
    }
  }
}

router.get("/connect", (req, res) => {
  cleanupPending();

  const returnUrl =
    String(req.query.returnUrl || req.query.redirect || "").trim() ||
    `${process.env.FRONTEND_URL || "http://localhost:5173"}/connections`;

  const state = `pass-tiktok-${crypto.randomBytes(8).toString("hex")}`;
  pendingReturns.set(state, { returnUrl, createdAt: Date.now() });

  const authUrl = tiktokService.buildAuthorizationUrl(state);

  if (!authUrl) {
    return res.redirect(
      frontendConnections(
        "error",
        "ยังไม่ได้ตั้ง TIKTOK_APP_KEY และ TIKTOK_APP_SECRET ในไฟล์ .env",
        returnUrl
      )
    );
  }

  res.redirect(authUrl);
});

router.get("/callback", async (req, res) => {
  cleanupPending();

  const state = String(req.query.state || "").trim();
  const pending = state ? pendingReturns.get(state) : null;
  if (state) {
    pendingReturns.delete(state);
  }
  const returnUrl =
    (pending && pending.returnUrl) ||
    `${process.env.FRONTEND_URL || "http://localhost:5173"}/connections`;

  try {
    const code = String(req.query.code || "").trim();
    if (!code) {
      return res.redirect(
        frontendConnections("error", "TikTok ไม่ได้ส่งรหัสอนุญาตกลับมา", returnUrl)
      );
    }

    await tiktokService.completeOAuth(req.query);
    res.redirect(frontendConnections("success", "เชื่อมต่อ TikTok สำเร็จ", returnUrl));
  } catch (error) {
    console.error("TikTok connect failed:", error.message);
    res.redirect(
      frontendConnections(
        "error",
        publicError(error, "เชื่อมต่อ TikTok ไม่สำเร็จ"),
        returnUrl
      )
    );
  }
});

module.exports = router;
