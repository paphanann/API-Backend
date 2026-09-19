const express = require("express");
const router = express.Router();

const { normalizePlatform } = require("../utils/platform");
const { publicError } = require("../utils/normalize");
const { frontendConnections } = require("../utils/frontendConnections");
const { ensureSchema } = require("../services/stores/schema");
const connectionStore = require("../services/stores/connectionStore");
const shopeeService = require("../services/marketplaces/shopeeService");
const tiktokService = require("../services/marketplaces/tiktokService");
const lazadaService = require("../services/marketplaces/lazadaService");

const services = {
  shopee: shopeeService,
  tiktok: tiktokService,
};

const missingKeyMessage = {
  shopee: "ยังไม่ได้ตั้ง SHOPEE_PARTNER_ID และ SHOPEE_PARTNER_KEY ในไฟล์ .env",
  tiktok: "ยังไม่ได้ตั้ง TIKTOK_APP_KEY และ TIKTOK_APP_SECRET ในไฟล์ .env",
  lazada: "ยังไม่ได้ตั้ง LAZADA_APP_KEY และ LAZADA_APP_SECRET ในไฟล์ .env",
};

function startConnect(slug) {
  return (req, res) => {
    const service = services[slug];
    const authorizationUrl = service.buildAuthorizationUrl();

    if (!authorizationUrl) {
      return res.redirect(
        frontendConnections("error", missingKeyMessage[slug] || "ยังไม่ได้ตั้งค่า App Key ใน Backend")
      );
    }

    if (slug === "tiktok") {
      console.log("TikTok authorize URL:", authorizationUrl);
    }

    return res.redirect(authorizationUrl);
  };
}

function handleCallback(slug) {
  return async (req, res) => {
    try {
      console.log(`${slug} callback query:`, {
        code: req.query.code ? `[len=${String(req.query.code).length}]` : null,
        shop_id: req.query.shop_id || null,
        main_account_id: req.query.main_account_id || null,
        error: req.query.error || null,
      });
      await services[slug].completeOAuth(req.query);
      res.redirect(frontendConnections("success", "เชื่อมต่อสำเร็จ"));
    } catch (error) {
      console.error(`${slug} connect failed:`, error.message);
      res.redirect(frontendConnections("error", publicError(error, "เชื่อมต่อไม่สำเร็จ")));
    }
  };
}

router.get("/", async (req, res) => {
  try {
    await ensureSchema();

    try {
      const lazada = await connectionStore.getConnected("Lazada");
      if (
        lazada &&
        (String(lazada.shopName || "").includes("@") ||
          String(lazada.shopId || "").includes("@") ||
          !lazada.openId)
      ) {
        await lazadaService.refreshShopProfile(lazada);
      }
    } catch (error) {
      console.warn("Lazada profile refresh skipped:", error.message);
    }

    const rows = await connectionStore.listPublicConnections();
    console.log(
      `GET /api/connections → ${rows.length} row(s)`,
      rows.map((r) => `${r.Platform}:${r.ShopId || "-"}:${r.Status}`).join(", ") || "(empty)"
    );
    res.json(rows);
  } catch (error) {
    console.error(error);

    res.status(500).json({
      message: "ไม่สามารถดึงข้อมูลการเชื่อมต่อได้",
    });
  }
});

router.get("/shopee/connect", startConnect("shopee"));
router.get("/tiktok/connect", (req, res) => {
  const query = new URLSearchParams(req.query).toString();
  res.redirect(`/api/tiktok/connect${query ? `?${query}` : ""}`);
});
router.get("/lazada/connect", (req, res) => {
  const query = new URLSearchParams(req.query).toString();
  res.redirect(`/api/lazada/connect${query ? `?${query}` : ""}`);
});

router.get("/lazada/callback", (req, res) => {
  const query = new URLSearchParams(req.query).toString();
  res.redirect(`/api/lazada/callback${query ? `?${query}` : ""}`);
});

router.get("/shopee/callback", handleCallback("shopee"));
router.get("/tiktok/callback", (req, res) => {
  const query = new URLSearchParams(req.query).toString();
  res.redirect(`/api/tiktok/callback${query ? `?${query}` : ""}`);
});

router.post("/refresh-tokens", async (req, res) => {
  try {
    const { refreshDueConnections } = require("../services/sync/tokenRefreshJob");
    const summary = await refreshDueConnections();
    res.json({
      success: true,
      message: "รัน refresh token จาก backend แล้ว",
      ...summary,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      message: publicError(error, "Refresh token ไม่สำเร็จ"),
    });
  }
});

router.post("/:platform/disconnect", async (req, res) => {
  try {
    const platform = normalizePlatform(req.params.platform);
    await connectionStore.disconnectPlatform(platform);

    res.json({
      success: true,
      message: `ยกเลิกการเชื่อมต่อ ${platform} แล้ว`,
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      message: "ไม่สามารถยกเลิกการเชื่อมต่อได้",
    });
  }
});

module.exports = router;
