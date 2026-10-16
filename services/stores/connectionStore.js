const { poolPromise, sql } = require("../../config/database");
const { ensureSchema } = require("./schema");
const { currentCompanyId } = require("./companyContext");
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
  const companyId = fields.companyId ? String(fields.companyId) : await currentCompanyId();
  const userId = fields.userId || defaultUserId();
  const sellerId = fields.sellerId || fields.openId || null;

  // จับคู่ร้านเดิมจากบริษัท + แพลตฟอร์ม + Shop ID ไม่สร้างซ้ำ และไม่ทับร้านอื่น
  await pool
    .request()
    .input("companyId", sql.NVarChar(100), companyId)
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
          AND ISNULL(CompanyId, N'') = ISNULL(@companyId, N'')
          AND ISNULL(ShopId, N'') = ISNULL(@shopId, N'')
        ORDER BY UpdatedAt DESC, ConnectionId DESC
      );

      IF @id IS NOT NULL
      BEGIN
        UPDATE dbo.MarketplaceConnection
        SET
          CompanyId = @companyId,
          UserId = @userId,
          ShopId = @shopId,
          ShopName = COALESCE(@shopName, ShopName),
          ShopCipher = COALESCE(@shopCipher, ShopCipher),
          SellerId = COALESCE(@sellerId, SellerId),
          ConnectionStatus = N'CONNECTED',
          AuthorizedAt = GETDATE(),
          UpdatedAt = GETDATE()
        WHERE ConnectionId = @id;
      END
      ELSE
      BEGIN
        INSERT INTO dbo.MarketplaceConnection
        (
          CompanyId,
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
          @companyId,
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
    companyId,
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
  const companyId = fields.companyId ? String(fields.companyId) : await currentCompanyId();
  const sellerId = fields.sellerId || fields.openId || null;

  const fromShopId = fields.fromShopId ? String(fields.fromShopId) : null;
  const current = fromShopId
    ? (await listConnected(platform)).find((row) => String(row.shopId || "") === fromShopId) ||
      (await getConnection(platform, fromShopId))
    : await getConnected(platform);
  if (!current) {
    return saveConnection({ platform, ...fields });
  }

  const oldShopId = String(current.shopId || "");
  const nextShopId = shopId || oldShopId;

  await pool
    .request()
    .input("companyId", sql.NVarChar(100), companyId)
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
        AND ISNULL(CompanyId, N'') = ISNULL(@companyId, N'')
        AND ISNULL(ShopId, N'') = ISNULL(@oldShopId, N'')
    `);

  if (fields.accessToken) {
    await tokenService.saveTokens({
      platform,
      companyId,
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

async function getConnection(platform, shopId, companyId) {
  await ensureSchema();
  const pool = await poolPromise;
  const company = companyId ? String(companyId) : await currentCompanyId();
  const result = await pool
    .request()
    .input("companyId", sql.NVarChar(100), company)
    .input("platform", sql.NVarChar(50), platform)
    .input("shopId", sql.NVarChar(100), String(shopId || ""))
    .query(`
      SELECT TOP 1 *
      FROM dbo.MarketplaceConnection
      WHERE Platform = @platform
        AND ISNULL(CompanyId, N'') = ISNULL(@companyId, N'')
        AND ISNULL(ShopId, N'') = ISNULL(@shopId, N'')
      ORDER BY UpdatedAt DESC, ConnectionId DESC
    `);

  const row = result.recordset[0];
  return row ? reveal(row) : null;
}

async function listConnected(platform) {
  await ensureSchema();
  const pool = await poolPromise;
  const request = pool.request().input("companyId", sql.NVarChar(100), await currentCompanyId());
  let where = `
    WHERE ISNULL(CompanyId, N'') = ISNULL(@companyId, N'')
      AND UPPER(ConnectionStatus) = N'CONNECTED'
      AND AccessToken IS NOT NULL
      AND LEN(AccessToken) > 0
  `;
  if (platform) {
    request.input("platform", sql.NVarChar(50), platform);
    where += " AND Platform = @platform";
  }

  const result = await request.query(`
    SELECT *
    FROM dbo.MarketplaceConnection
    ${where}
    ORDER BY Platform, ShopName, ConnectionId
  `);

  return result.recordset.map(reveal);
}

async function getConnected(platform) {
  const rows = await listConnected(platform);
  return rows[0] || null;
}

function reveal(row) {
  const tokens = tokenService.revealTokens(row);

  return {
    id: row.ConnectionId || row.AuthorizationId || row.Id,
    userId: row.UserId,
    companyId: row.CompanyId || null,
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
  const companyId = connection.companyId ? String(connection.companyId) : await currentCompanyId();

  await pool
    .request()
    .input("companyId", sql.NVarChar(100), companyId)
    .input("platform", sql.NVarChar(50), connection.platform)
    .input("shopId", sql.NVarChar(100), String(connection.shopId || ""))
    .query(`
      UPDATE dbo.MarketplaceConnection
      SET LastSyncAt = GETDATE(), UpdatedAt = GETDATE()
      WHERE Platform = @platform
        AND ISNULL(CompanyId, N'') = ISNULL(@companyId, N'')
        AND ShopId = @shopId
    `);
}

async function listPublicConnections() {
  await ensureSchema();
  const pool = await poolPromise;
  const companyId = await currentCompanyId();

  const result = await pool.request().input("companyId", sql.NVarChar(100), companyId).query(`
    SELECT
      ConnectionId AS Id,
      CompanyId,
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
    WHERE ISNULL(CompanyId, N'') = ISNULL(@companyId, N'')
    ORDER BY UpdatedAt DESC
  `);

  const shops = [];

  for (const row of result.recordset) {
    const platform = String(row.Platform || "").trim();
    const shopId = row.ShopId || row.SellerId || null;
    if (!platform || !shopId) {
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

    shops.push({
      Id: row.Id,
      CompanyId: row.CompanyId || companyId,
      companyId: row.CompanyId || companyId,
      Platform: platform,
      platform,
      ShopId: shopId,
      shopId,
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
      Cleared: 0,
    });
  }

  const platforms = ["Shopee", "TikTok", "Lazada"];
  for (const platform of platforms) {
    const hasShop = shops.some((row) => String(row.Platform).toLowerCase() === platform.toLowerCase());
    if (hasShop) {
      continue;
    }

    shops.push({
      CompanyId: companyId,
      companyId,
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
      Cleared: 1,
    });
  }

  return shops;
}

async function disconnectPlatform(platform, shopId) {
  await tokenService.clearTokens(platform, shopId);
}

async function deleteShop(platform, shopId) {
  await ensureSchema();
  const pool = await poolPromise;
  const request = pool
    .request()
    .input("companyId", sql.NVarChar(100), await currentCompanyId())
    .input("platform", sql.NVarChar(50), String(platform || "").trim());

  const result = shopId
    ? await request.input("shopId", sql.NVarChar(100), String(shopId)).query(`
        DELETE FROM dbo.MarketplaceConnection
        WHERE Platform = @platform
          AND ISNULL(CompanyId, N'') = ISNULL(@companyId, N'')
          AND ISNULL(ShopId, N'') = ISNULL(@shopId, N'');
        SELECT @@ROWCOUNT AS Deleted;
      `)
    : await request.query(`
        DELETE FROM dbo.MarketplaceConnection
        WHERE Platform = @platform
          AND ISNULL(CompanyId, N'') = ISNULL(@companyId, N'');
        SELECT @@ROWCOUNT AS Deleted;
      `);

  const deleted = Number(result.recordset && result.recordset[0] && result.recordset[0].Deleted) || 0;
  console.log(`Deleted marketplace shop: ${platform}${shopId ? ` shop=${shopId}` : ""} rows=${deleted}`);
  return deleted;
}

function assertLiveToken(accessToken) {
  tokenService.assertLiveToken(accessToken);
}

module.exports = {
  saveConnection,
  updateConnectedShop,
  getConnection,
  listConnected,
  getConnected,
  updateTokens,
  touchSync,
  listPublicConnections,
  disconnectPlatform,
  deleteShop,
  assertLiveToken,
};
