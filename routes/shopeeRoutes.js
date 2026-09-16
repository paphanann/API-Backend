const express = require("express");
const crypto = require("crypto");
const axios = require("axios");

const { poolPromise, sql } = require("../config/database");

const router = express.Router();

const partnerId = Number(process.env.SHOPEE_PARTNER_ID);
const partnerKey = process.env.SHOPEE_PARTNER_KEY;
const host = process.env.SHOPEE_HOST;
const redirectUri = process.env.SHOPEE_REDIRECT_URI;


// ==========================================
// 1. กด Connect Shopee
// ==========================================
router.get("/connect", async (req, res) => {
  try {

    const path = "/api/v2/shop/auth_partner";
    const timestamp = Math.floor(Date.now() / 1000);

    // auth_partner ใช้
    // partner_id + path + timestamp
    const baseString =
      `${partnerId}${path}${timestamp}`;

    const sign = crypto
      .createHmac("sha256", partnerKey)
      .update(baseString)
      .digest("hex");

    const authUrl =
      `${host}${path}` +
      `?partner_id=${partnerId}` +
      `&timestamp=${timestamp}` +
      `&sign=${sign}` +
      `&redirect=${encodeURIComponent(redirectUri)}`;

    console.log("Shopee Auth URL:");
    console.log(authUrl);

    res.redirect(authUrl);

  } catch (error) {

    console.error(error);

    res.status(500).json({
      success: false,
      message: "ไม่สามารถสร้าง Shopee Authorization URL ได้"
    });
  }
});


// ==========================================
// 2. Shopee ส่ง code + shop_id กลับมาที่นี่
// ==========================================
router.get("/callback", async (req, res) => {
  try {

    const { code, shop_id } = req.query;

    console.log("Shopee callback");
    console.log("code =", code);
    console.log("shop_id =", shop_id);

    if (!code || !shop_id) {
      return res.status(400).send(
        "Shopee ไม่ได้ส่ง code หรือ shop_id กลับมา"
      );
    }


    // ======================================
    // 3. เอา code ไปแลก Access Token
    // ======================================

    const path = "/api/v2/auth/token/get";
    const timestamp = Math.floor(Date.now() / 1000);

    const baseString =
      `${partnerId}${path}${timestamp}`;

    const sign = crypto
      .createHmac("sha256", partnerKey)
      .update(baseString)
      .digest("hex");

    const tokenUrl =
      `${host}${path}` +
      `?partner_id=${partnerId}` +
      `&timestamp=${timestamp}` +
      `&sign=${sign}`;

    const body = {
      code: code,
      shop_id: Number(shop_id),
      partner_id: partnerId
    };

    const tokenResponse = await axios.post(
      tokenUrl,
      body,
      {
        headers: {
          "Content-Type": "application/json"
        }
      }
    );

    console.log("Shopee token response:");
    console.log(tokenResponse.data);


    if (tokenResponse.data.error) {

      console.error(
        "Shopee Token Error:",
        tokenResponse.data
      );

      return res.status(400).json(
        tokenResponse.data
      );
    }


    const accessToken =
      tokenResponse.data.access_token;

    const refreshToken =
      tokenResponse.data.refresh_token;

    const expireIn =
      tokenResponse.data.expire_in || 14400;


    // ======================================
    // 4. บันทึกลง SQL Server
    // ======================================

    const pool = await poolPromise;

    await pool
      .request()

      .input(
        "Platform",
        sql.NVarChar,
        "Shopee"
      )

      .input(
        "ShopId",
        sql.NVarChar,
        String(shop_id)
      )

      .input(
        "AccessToken",
        sql.NVarChar(sql.MAX),
        accessToken
      )

      .input(
        "RefreshToken",
        sql.NVarChar(sql.MAX),
        refreshToken
      )

      .input(
        "ExpireIn",
        sql.Int,
        expireIn
      )

      .query(`
        IF EXISTS (
          SELECT 1
          FROM MarketplaceConnection
          WHERE Platform = @Platform
          AND ShopId = @ShopId
        )
        BEGIN

          UPDATE MarketplaceConnection

          SET
            AccessToken = @AccessToken,
            RefreshToken = @RefreshToken,
            TokenExpiresAt =
              DATEADD(
                SECOND,
                @ExpireIn,
                GETDATE()
              ),

            Status = 'connected',
            ConnectedAt = GETDATE(),
            UpdatedAt = GETDATE()

          WHERE
            Platform = @Platform
            AND ShopId = @ShopId;

        END

        ELSE

        BEGIN

          INSERT INTO MarketplaceConnection
          (
            Platform,
            ShopId,
            AccessToken,
            RefreshToken,
            TokenExpiresAt,
            Status,
            ConnectedAt,
            CreatedAt,
            UpdatedAt
          )

          VALUES
          (
            @Platform,
            @ShopId,
            @AccessToken,
            @RefreshToken,

            DATEADD(
              SECOND,
              @ExpireIn,
              GETDATE()
            ),

            'connected',
            GETDATE(),
            GETDATE(),
            GETDATE()
          );

        END
      `);


    console.log("บันทึก Shopee ลง Database แล้ว");


    // ======================================
    // 5. ส่ง User กลับหน้า PASS
    // ======================================

    res.redirect(
      `${process.env.FRONTEND_URL}/connections?shopee=connected`
    );

  } catch (error) {

    console.error(
      "Shopee Callback Error:",
      error.response?.data || error.message
    );

    res.status(500).json({
      success: false,
      message: "เชื่อมต่อ Shopee ไม่สำเร็จ",

      error:
        error.response?.data ||
        error.message
    });
  }
});


// ==========================================
// 6. API สำหรับ Frontend ดึงสถานะ Shopee
// ==========================================
router.get("/status", async (req, res) => {
  try {

    const pool = await poolPromise;

    const result = await pool
      .request()
      .query(`
        SELECT TOP 1

          Id,
          Platform,
          ShopId,
          ShopName,
          Status,
          ConnectedAt,
          LastSyncAt

        FROM MarketplaceConnection

        WHERE Platform = 'Shopee'

        ORDER BY ConnectedAt DESC
      `);


    if (result.recordset.length === 0) {

      return res.json({
        connected: false
      });

    }


    const shop = result.recordset[0];


    res.json({
      connected:
        shop.Status === "connected",

      platform:
        shop.Platform,

      shopId:
        shop.ShopId,

      shopName:
        shop.ShopName,

      connectedAt:
        shop.ConnectedAt,

      lastSyncAt:
        shop.LastSyncAt
    });

  } catch (error) {

    console.error(error);

    res.status(500).json({
      message:
        "ไม่สามารถตรวจสอบสถานะ Shopee ได้"
    });
  }
});


module.exports = router;