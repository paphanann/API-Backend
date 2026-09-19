const { poolPromise, sql } = require("../../config/database");
const { ensureSchema } = require("./schema");
const tokenService = require("../tokenService");

function defaultUserId() {
  const raw = Number(process.env.DEFAULT_USER_ID || 1);
  return Number.isFinite(raw) && raw > 0 ? raw : 1;
}

function toPublicStatus(connectionStatus) {
  const raw = String(connectionStatus || "").trim().toUpperCase();
  if (raw === "CONNECTED" || raw === "LIVE" || raw === "SUCCESS") {
    return "connected";
  }
  if (raw === "EXPIRED") {
    return "expired";
  }
  return "disconnected";
}

/** DATETIME จาก SQL ที่เก็บเป็นเวลาไทย — ส่งออกเป็น +07:00 ให้หน้าบ้านไม่เพี้ยน */
function asThaiIso(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) {
    return null;
  }

  const pad = (n) => String(n).padStart(2, "0");
  const y = d.getUTCFullYear();
  const m = pad(d.getUTCMonth() + 1);
  const day = pad(d.getUTCDate());
  const h = pad(d.getUTCHours());
  const min = pad(d.getUTCMinutes());
  const sec = pad(d.getUTCSeconds());
  return `${y}-${m}-${day}T${h}:${min}:${sec}+07:00`;
}

async function saveConnection(fields) {
  await ensureSchema();
  const pool = await poolPromise;
  const shopId = fields.shopId ? String(fields.shopId) : "unknown";
  const userId = fields.userId || defaultUserId();
  const sellerId = fields.sellerId || fields.openId || null;

  // ระบบนี้เก็บ 1 ร้านต่อแพลตฟอร์ม — upsert ตาม Platform อย่างเดียว
  // (reconnect แล้ว ShopId เปลี่ยน จะอัปเดตแถวเดิม ไม่สร้างแถวใหม่ที่ไม่มี token)
  await pool
    .request()
    .input("userId", sql.Int, userId)
    .input("platform", sql.NVarChar(50), fields.platform)
    .input("shopId", sql.NVarChar(100), shopId)
    .input("shopName", sql.NVarChar(255), fields.shopName || null)
    .input("shopCipher", sql.NVarChar(500), fields.shopCipher || null)
    .input("sellerId", sql.NVarChar(200), sellerId)
    .query(`
      DECLARE @id INT =
      (
        SELECT TOP 1 ConnectionId
        FROM dbo.MarketplaceConnection
        WHERE Platform = @platform
        ORDER BY UpdatedAt DESC, ConnectionId DESC
      );

      IF @id IS NOT NULL
      BEGIN
        UPDATE dbo.MarketplaceConnection
        SET
          UserId = @userId,
          ShopId = @shopId,
          ShopName = COALESCE(@shopName, ShopName),
          ShopCipher = COALESCE(@shopCipher, ShopCipher),
          SellerId = COALESCE(@sellerId, SellerId),
          ConnectionStatus = N'CONNECTED',
          AuthorizedAt = GETDATE(),
          UpdatedAt = GETDATE()
        WHERE ConnectionId = @id;

        -- ลบแถวซ้ำของแพลตฟอร์มเดียวกัน (กันข้อมูลเบิ้ลจาก reconnect เก่า)
        DELETE FROM dbo.MarketplaceConnection
        WHERE Platform = @platform
          AND ConnectionId <> @id;
      END
      ELSE
      BEGIN
        INSERT INTO dbo.MarketplaceConnection
        (
          UserId,
          Platform,
          ShopId,
          ShopName,
          ShopCipher,
          SellerId,
          ConnectionStatus,
          AuthorizedAt,
          CreatedAt,
          UpdatedAt
        )
        VALUES
        (
          @userId,
          @platform,
          @shopId,
          @shopName,
          @shopCipher,
          @sellerId,
          N'CONNECTED',
          GETDATE(),
          GETDATE(),
          GETDATE()
        )
      END
    `);

  await tokenService.saveTokens({
    platform: fields.platform,
    shopId,
    accessToken: fields.accessToken,
    refreshToken: fields.refreshToken,
    accessTokenExpireAt: fields.accessTokenExpireAt || null,
    refreshTokenExpireAt: fields.refreshTokenExpireAt || null,
    shopCipher: fields.shopCipher || null,
  });

  console.log(`Saved MarketplaceConnection: ${fields.platform} shop=${shopId}`);
}

async function updateConnectedShop(platform, fields) {
  await ensureSchema();
  const pool = await poolPromise;
  const shopId = fields.shopId ? String(fields.shopId) : null;
  const sellerId = fields.sellerId || fields.openId || null;

  const current = await getConnected(platform);
  if (!current) {
    return saveConnection({ platform, ...fields });
  }

  const oldShopId = String(current.shopId || "");
  const nextShopId = shopId || oldShopId;

  await pool
    .request()
    .input("platform", sql.NVarChar(50), platform)
    .input("oldShopId", sql.NVarChar(100), oldShopId)
    .input("shopId", sql.NVarChar(100), nextShopId)
    .input("shopName", sql.NVarChar(255), fields.shopName || null)
    .input("sellerId", sql.NVarChar(200), sellerId)
    .query(`
      UPDATE dbo.MarketplaceConnection
      SET
        ShopId = @shopId,
        ShopName = COALESCE(@shopName, ShopName),
        SellerId = COALESCE(@sellerId, SellerId),
        ConnectionStatus = N'CONNECTED',
        AuthorizedAt = COALESCE(AuthorizedAt, GETDATE()),
        UpdatedAt = GETDATE()
      WHERE Platform = @platform
        AND ISNULL(ShopId, N'') = ISNULL(@oldShopId, N'')
    `);

  if (fields.accessToken) {
    await tokenService.saveTokens({
      platform,
      shopId: nextShopId,
      accessToken: fields.accessToken,
      refreshToken: fields.refreshToken || current.refreshToken,
      accessTokenExpireAt: fields.accessTokenExpireAt || current.accessTokenExpireAt,
      refreshTokenExpireAt: fields.refreshTokenExpireAt || current.refreshTokenExpireAt,
      shopCipher: fields.shopCipher || current.shopCipher,
    });
  }

  console.log(
    `Updated MarketplaceConnection profile: ${platform} ${oldShopId} -> ${nextShopId}`
  );
}

async function getConnected(platform) {
  await ensureSchema();
  const pool = await poolPromise;

  const result = await pool
    .request()
    .input("platform", sql.NVarChar(50), platform)
    .query(`
      SELECT TOP 1 *
      FROM dbo.MarketplaceConnection
      WHERE Platform = @platform
        AND UPPER(ConnectionStatus) = N'CONNECTED'
      ORDER BY UpdatedAt DESC
    `);

  const row = result.recordset[0];
  return row ? reveal(row) : null;
}

function reveal(row) {
  const tokens = tokenService.revealTokens(row);

  return {
    id: row.ConnectionId || row.AuthorizationId || row.Id,
    userId: row.UserId,
    platform: row.Platform,
    shopId: row.ShopId,
    shopName: row.ShopName,
    shopCipher: row.ShopCipher,
    openId: row.SellerId || row.OpenId,
    status: toPublicStatus(row.ConnectionStatus || row.Status),
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    accessTokenExpireAt: tokens.accessTokenExpireAt,
    refreshTokenExpireAt: tokens.refreshTokenExpireAt,
    connectedAt: row.AuthorizedAt || row.CreatedAt || row.UpdatedAt,
    lastSyncAt: row.LastSyncAt,
    lastRefreshAt: row.LastRefreshAt || null,
  };
}

async function updateTokens(connection, tokens) {
  return tokenService.saveTokens({
    platform: connection.platform,
    shopId: connection.shopId,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    accessTokenExpireAt: tokens.accessTokenExpireAt,
    refreshTokenExpireAt: tokens.refreshTokenExpireAt,
    shopCipher: tokens.shopCipher || connection.shopCipher,
  });
}

async function touchSync(connection) {
  const pool = await poolPromise;

  await pool
    .request()
    .input("platform", sql.NVarChar(50), connection.platform)
    .input("shopId", sql.NVarChar(100), String(connection.shopId || ""))
    .query(`
      UPDATE dbo.MarketplaceConnection
      SET LastSyncAt = GETDATE(), UpdatedAt = GETDATE()
      WHERE Platform = @platform
        AND ShopId = @shopId
    `);
}

async function listPublicConnections() {
  await ensureSchema();
  const pool = await poolPromise;

  const result = await pool.request().query(`
    SELECT
      ConnectionId AS Id,
      Platform,
      ShopId,
      ShopName,
      SellerId,
      ShopCipher,
      ConnectionStatus,
      COALESCE(AuthorizedAt, CreatedAt) AS ConnectedAt,
      AuthorizedAt,
      LastSyncAt,
      LastRefreshAt,
      CASE WHEN AccessToken IS NOT NULL AND LEN(AccessToken) > 0 THEN 1 ELSE 0 END AS HasAccessToken,
      CASE WHEN RefreshToken IS NOT NULL AND LEN(RefreshToken) > 0 THEN 1 ELSE 0 END AS HasRefreshToken,
      AccessTokenExpiresAt,
      RefreshTokenExpiresAt
    FROM dbo.MarketplaceConnection
    ORDER BY UpdatedAt DESC
  `);

  const byPlatform = new Map();

  for (const row of result.recordset) {
    const platform = String(row.Platform || "").trim();
    if (!platform || byPlatform.has(platform.toLowerCase())) {
      continue;
    }

    const statusRaw = toPublicStatus(row.ConnectionStatus);
    const hasAccess = Number(row.HasAccessToken) === 1;
    const hasRefresh = Number(row.HasRefreshToken) === 1;
    const hasShopCipher = Boolean(String(row.ShopCipher || "").trim());
    const refreshExpired =
      row.RefreshTokenExpiresAt &&
      new Date(row.RefreshTokenExpiresAt).getTime() <= Date.now();
    const looksConnected = statusRaw === "connected";
    const tiktokMissingCipher =
      platform.toLowerCase() === "tiktok" && hasAccess && !hasShopCipher;
    const needsReauth =
      looksConnected &&
      (!hasAccess || refreshExpired === true || tiktokMissingCipher);
    const connected = looksConnected && hasAccess && !needsReauth;

    byPlatform.set(platform.toLowerCase(), {
      Id: row.Id,
      Platform: platform,
      platform,
      ShopId: row.ShopId || row.SellerId || null,
      shopId: row.ShopId || row.SellerId || null,
      ShopName: row.ShopName || null,
      shopName: row.ShopName || null,
      SellerId: row.SellerId || null,
      HasShopCipher: hasShopCipher ? 1 : 0,
      Status: connected ? "connected" : needsReauth ? "expired" : "disconnected",
      status: connected ? "connected" : needsReauth ? "expired" : "disconnected",
      ConnectedAt:
        connected || needsReauth ? asThaiIso(row.ConnectedAt) : null,
      AuthorizedAt:
        connected || needsReauth
          ? asThaiIso(row.AuthorizedAt || row.ConnectedAt)
          : null,
      LastSyncAt: asThaiIso(row.LastSyncAt),
      lastSyncAt: asThaiIso(row.LastSyncAt),
      LastRefreshAt: asThaiIso(row.LastRefreshAt),
      HasToken: hasAccess ? 1 : 0,
      HasAccessToken: hasAccess ? 1 : 0,
      HasRefreshToken: hasRefresh ? 1 : 0,
      NeedsReauth: needsReauth ? 1 : 0,
      TokenExpired: refreshExpired ? 1 : 0,
      Message: tiktokMissingCipher
        ? "TikTok ยังไม่มี shop_cipher — เปิด scope ใน Partner Center แล้ว Connect ใหม่"
        : null,
      // ให้หน้าบ้านรู้ว่าตัดการเชื่อมแล้วจริง ไม่โชว์ชื่อร้านค้างเป็น needsReauth
      Cleared: connected || needsReauth ? 0 : 1,
    });
  }

  const platforms = ["Shopee", "TikTok", "Lazada"];
  return platforms.map((platform) => {
    const existing = byPlatform.get(platform.toLowerCase());
    if (existing) {
      return existing;
    }

    return {
      Platform: platform,
      platform,
      ShopId: null,
      shopId: null,
      ShopName: null,
      shopName: null,
      SellerId: null,
      Status: "disconnected",
      status: "disconnected",
      ConnectedAt: null,
      AuthorizedAt: null,
      LastSyncAt: null,
      lastSyncAt: null,
      LastRefreshAt: null,
      HasToken: 0,
      HasAccessToken: 0,
      HasRefreshToken: 0,
      NeedsReauth: 0,
      TokenExpired: 0,
    };
  });
}

async function disconnectPlatform(platform) {
  await tokenService.clearTokens(platform);
}

function assertLiveToken(accessToken) {
  tokenService.assertLiveToken(accessToken);
}

module.exports = {
  saveConnection,
  updateConnectedShop,
  getConnected,
  updateTokens,
  touchSync,
  listPublicConnections,
  disconnectPlatform,
  assertLiveToken,
};
