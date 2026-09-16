const express = require("express");

const lazadaService = require("../services/lazadaService");
const { publicError } = require("../utils/normalize");

const router = express.Router();

function frontendConnections(status, message) {
  const base = process.env.FRONTEND_URL || "http://localhost:5173";
  const url = new URL("/connections", base);
  url.searchParams.set("status", status);
  url.searchParams.set(
    "message",
    message || (status === "success" ? "เชื่อมต่อสำเร็จ" : "")
  );
  return url.toString();
}

router.get("/connect", (req, res) => {
  const authUrl = lazadaService.buildAuthorizationUrl();

  if (!authUrl) {
    return res.redirect(
      frontendConnections("error", "ยังไม่ได้ตั้ง LAZADA_APP_KEY และ LAZADA_APP_SECRET ในไฟล์ .env")
    );
  }

  console.log("Lazada authorize redirect_uri:", lazadaService.getConfig().redirectUrl);
  res.redirect(authUrl);
});

router.get("/callback", async (req, res) => {
  try {
    await lazadaService.completeOAuth(req.query);
    res.redirect(frontendConnections("success", "เชื่อมต่อสำเร็จ"));
  } catch (error) {
    console.error("Lazada connect failed:", error.message);
    res.redirect(frontendConnections("error", publicError(error, "เชื่อมต่อ Lazada ไม่สำเร็จ")));
  }
});

module.exports = router;
