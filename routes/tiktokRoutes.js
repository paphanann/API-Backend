const express = require("express");
const crypto = require("crypto");

const tiktokService = require("../services/tiktokService");
const { publicError } = require("../utils/normalize");

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

function frontendConnections(status, message, returnBase) {
  const base =
    returnBase ||
    process.env.FRONTEND_URL ||
    "http://localhost:5173";
  const url = new URL(base.includes("/connections") ? base : `${base.replace(/\/$/, "")}/connections`);
  url.searchParams.set("status", status);
  url.searchParams.set(
    "message",
    message || (status === "success" ? "เชื่อมต่อสำเร็จ" : "")
  );
  return url.toString();
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

  console.log("TikTok authorize URL:", authUrl);
  console.log("TikTok return after callback:", returnUrl);
  res.redirect(authUrl);
});

router.get("/callback", async (req, res) => {
  cleanupPending();

  const state = String(req.query.state || "");
  const pending = pendingReturns.get(state);
  if (pending) {
    pendingReturns.delete(state);
  }
  const returnUrl =
    (pending && pending.returnUrl) ||
    `${process.env.FRONTEND_URL || "http://localhost:5173"}/connections`;

  try {
    const code = req.query.code || req.query.auth_code;

    if (!code) {
      console.error("TikTok callback missing code:", req.query);
      return res.redirect(
        frontendConnections("error", "TikTok ไม่ได้ส่งรหัสอนุญาตกลับมา", returnUrl)
      );
    }

    console.log("TikTok Authorization Code received (hidden length):", String(code).length);

    const shop = await tiktokService.completeOAuth(req.query);
    console.log(
      `TikTok saved MarketplaceConnection shop=${shop.shopId || "-"} name=${shop.shopName || "-"}`
    );

    res.redirect(frontendConnections("success", "เชื่อมต่อ TikTok สำเร็จ", returnUrl));
  } catch (error) {
    console.error("TikTok connect failed:", error.message);
    if (error.response && error.response.data) {
      console.error("TikTok token error body:", error.response.data);
    }
    // token อาจบันทึกแล้วแต่ยังไม่มี shop_cipher — บอกให้ไปเปิด scope
    const status = error.partialSuccess ? "error" : "error";
    res.redirect(
      frontendConnections(
        status,
        publicError(error, "เชื่อมต่อ TikTok ไม่สำเร็จ"),
        returnUrl
      )
    );
  }
});

module.exports = router;
