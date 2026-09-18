const { poolPromise, sql } = require("../config/database");
const { encrypt, decrypt } = require("../utils/tokenCrypto");
const { ensureSchema } = require("./schema");

const REFRESH_SKEW_MS = 5 * 60 * 1000;

function encryptToken(plainText) {
  return encrypt(plainText);
}

function decryptToken(stored) {
  if (stored === undefined || stored === null || stored === "") {
    return null;
  }

  const value = String(stored);

  try {
    return decrypt(value);
  } catch {
    // แถวเก่าที่อาจเก็บเป็น plaintext
    return value;
  }
}

function needsRefresh(expireAt, skewMs = REFRESH_SKEW_MS) {
  if (!expireAt) {
    return false;
  }

  return new Date(expireAt).getTime() - Date.now() < skewMs;
}

const RECONNECT_MESSAGE =
  "สิทธิ์ร้านค้าหมดอายุแล้ว กรุณากด Connect แล้ว Authorize ใหม่ ไม่ต้องล็อกอิน PASS ซ้ำ";

function reconnectRequired(cause) {
  const error = new Error(RECONNECT_MESSAGE);
  error.code = "RECONNECT_REQUIRED";
  if (cause) {
    error.cause = cause;
  }
  return error;
}

function errorText(error) {
  return `${(error && error.code) || ""} ${(error && error.message) || ""}`.toLowerCase();
}

function isAuthError(error) {
  if (!error) {
    return false;
  }

  if (error.code === "RECONNECT_REQUIRED") {
    return false;
  }

  const hay = errorText(error);
  return (
    hay.includes("illegalaccesstoken") ||
    hay.includes("illegalrefreshtoken") ||
    hay.includes("invalid_acceess_token") ||
    hay.includes("invalid_access_token") ||
    hay.includes("invalid_refresh_token") ||
    hay.includes("error_auth") ||
    hay.includes("unauthorized") ||
    hay.includes("access token is expire") ||
    hay.includes("token is expire") ||
    hay.includes("token expired") ||
    hay.includes("expired token") ||
    String(error.code) === "105001" ||
    String(error.code) === "105002" ||
    Number(error.code) === 401
  );
}

function isRefreshRejected(error) {
  const hay = errorText(error);
  return (
    hay.includes("illegalrefreshtoken") ||
    hay.includes("invalid_refresh_token") ||
    (hay.includes("refresh") &&
      (hay.includes("invalid") || hay.includes("expir") || hay.includes("illegal")))
  );
}

function needsReconnect(connection) {
  if (!connection || !connection.refreshTokenExpireAt) {
    return false;
  }

  return new Date(connection.refreshTokenExpireAt).getTime() <= Date.now();
}

async function applyRefresh(connection, payload) {
  const next = {
    ...connection,
    accessToken: payload.accessToken || connection.accessToken,
    refreshToken: payload.refreshToken || connection.refreshToken,
    accessTokenExpireAt: payload.accessTokenExpireAt || connection.accessTokenExpireAt,
    refreshTokenExpireAt: payload.refreshTokenExpireAt || connection.refreshTokenExpireAt,
    shopCipher: payload.shopCipher || connection.shopCipher,
  };

  await saveTokens({
    platform: next.platform,
    shopId: next.shopId,
    accessToken: next.accessToken,
    refreshToken: next.refreshToken,
    accessTokenExpireAt: next.accessTokenExpireAt,
    refreshTokenExpireAt: next.refreshTokenExpireAt,
    shopCipher: next.shopCipher,
  });

  return next;
}

async function runWithFreshTokens(connection, ensureFreshTokens, work) {
  let fresh = await ensureFreshTokens(connection);

  try {
    return {
      connection: fresh,
      result: await work(fresh),
    };
  } catch (error) {
    if (!isAuthError(error)) {
      throw error;
    }

    fresh = await ensureFreshTokens(fresh, { force: true });
    return {
      connection: fresh,
      result: await work(fresh),
    };
  }
}

function assertLiveToken(accessToken) {
  if (!accessToken || String(accessToken).startsWith("sandbox-")) {
    throw new Error(
      "ยังไม่ได้เชื่อมต่อร้านค้าจริง กรุณากด Connect แล้ว Authorize ที่แพลตฟอร์ม"
    );
  }
}

function tokenMeta(accessToken, refreshToken, accessTokenExpireAt) {
  return {
    hasAccessToken: Boolean(accessToken),
    hasRefreshToken: Boolean(refreshToken),
    accessTokenLength: accessToken ? String(accessToken).length : 0,
    refreshTokenLength: refreshToken ? String(refreshToken).length : 0,
    accessTokenExpireAt: accessTokenExpireAt || null,
  };
}

function shopKey(platform, shopId) {
  return {
    platform: String(platform || "").trim(),
    shopId: shopId ? String(shopId) : "unknown",
  };
}

async function saveTokens({
  platform,
  shopId,
  accessToken,
  refreshToken,
  accessTokenExpireAt,
  refreshTokenExpireAt,
  shopCipher,
}) {
  if (!accessToken) {
    throw new Error("ไม่มี Access Token ให้บันทึกลงฐานข้อมูล");
  }

  await ensureSchema();

  const key = shopKey(platform, shopId);
  const pool = await poolPromise;
  const sealedAccess = encryptToken(accessToken);
  const sealedRefresh = refreshToken ? encryptToken(refreshToken) : null;

  const updated = await pool
    .request()
    .input("platform", sql.NVarChar(50), key.platform)
    .input("shopId", sql.NVarChar(100), key.shopId)
    .input("accessToken", sql.NVarChar(sql.MAX), sealedAccess)
    .input("refreshToken", sql.NVarChar(sql.MAX), sealedRefresh)
    .input("accessExpire", sql.DateTime2, accessTokenExpireAt || null)
    .input("refreshExpire", sql.DateTime2, refreshTokenExpireAt || null)
    .input("shopCipher", sql.NVarChar(500), shopCipher || null)
    .query(`
      DECLARE @id INT =
      (
        SELECT TOP 1 ConnectionId
        FROM dbo.MarketplaceConnection
        WHERE Platform = @platform
        ORDER BY UpdatedAt DESC, ConnectionId DESC
      );

      IF @id IS NULL
      BEGIN
        RAISERROR(N'ไม่พบแถว MarketplaceConnection สำหรับแพลตฟอร์มนี้', 16, 1);
      END

      UPDATE dbo.MarketplaceConnection
      SET
        ShopId = @shopId,
        AccessToken = @accessToken,
        RefreshToken = COALESCE(@refreshToken, RefreshToken),
        AccessTokenExpiresAt = @accessExpire,
        RefreshTokenExpiresAt = COALESCE(@refreshExpire, RefreshTokenExpiresAt),
        ShopCipher = COALESCE(@shopCipher, ShopCipher),
        ConnectionStatus = N'CONNECTED',
        LastRefreshAt = GETDATE(),
        UpdatedAt = GETDATE()
      WHERE ConnectionId = @id;

      DELETE FROM dbo.MarketplaceConnection
      WHERE Platform = @platform
        AND ConnectionId <> @id;
    `);

  const rowsUpdated = Number((updated.rowsAffected && updated.rowsAffected[0]) || 0);

  const verifyResult = await pool
    .request()
    .input("platform", sql.NVarChar(50), key.platform)
    .query(`
      SELECT TOP 1
        CASE WHEN AccessToken IS NOT NULL AND LEN(AccessToken) > 0 THEN 1 ELSE 0 END AS HasAccessToken,
        CASE WHEN RefreshToken IS NOT NULL AND LEN(RefreshToken) > 0 THEN 1 ELSE 0 END AS HasRefreshToken,
        AccessTokenExpiresAt
      FROM dbo.MarketplaceConnection
      WHERE Platform = @platform
      ORDER BY UpdatedAt DESC
    `);

  const verify = verifyResult.recordset && verifyResult.recordset[0];
  if (rowsUpdated < 1 || !verify || !verify.HasAccessToken) {
    throw new Error(
      `บันทึก token ไม่สำเร็จ (${key.platform} shop=${key.shopId})`
    );
  }

  console.log(
    `Saved marketplace tokens: ${key.platform} shop=${key.shopId}` +
      ` access=yes refresh=${verify.HasRefreshToken ? "yes" : "no"}` +
      ` expire=${verify.AccessTokenExpiresAt || "-"}`
  );

  return tokenMeta(accessToken, refreshToken, accessTokenExpireAt);
}

async function loadTokens(platform, shopId) {
  await ensureSchema();

  const key = shopKey(platform, shopId);
  const pool = await poolPromise;
  const request = pool
    .request()
    .input("platform", sql.NVarChar(50), key.platform);

  const result = shopId
    ? await request.input("shopId", sql.NVarChar(100), key.shopId).query(`
        SELECT TOP 1
          AccessToken,
          RefreshToken,
          AccessTokenExpiresAt,
          RefreshTokenExpiresAt,
          ShopCipher
        FROM dbo.MarketplaceConnection
        WHERE Platform = @platform
          AND ISNULL(ShopId, N'') = ISNULL(@shopId, N'')
        ORDER BY UpdatedAt DESC
      `)
    : await request.query(`
        SELECT TOP 1
          AccessToken,
          RefreshToken,
          AccessTokenExpiresAt,
          RefreshTokenExpiresAt,
          ShopCipher
        FROM dbo.MarketplaceConnection
        WHERE Platform = @platform
          AND UPPER(ConnectionStatus) = N'CONNECTED'
        ORDER BY UpdatedAt DESC
      `);

  const row = result.recordset[0];
  if (!row) {
    return null;
  }

  return {
    accessToken: decryptToken(row.AccessToken),
    refreshToken: decryptToken(row.RefreshToken),
    accessTokenExpireAt: row.AccessTokenExpiresAt,
    refreshTokenExpireAt: row.RefreshTokenExpiresAt,
    shopCipher: row.ShopCipher,
  };
}

async function clearTokens(platform) {
  await ensureSchema();
  const pool = await poolPromise;

  await pool
    .request()
    .input("platform", sql.NVarChar(50), String(platform || "").trim())
    .query(`
      UPDATE dbo.MarketplaceConnection
      SET
        AccessToken = NULL,
        RefreshToken = NULL,
        AccessTokenExpiresAt = NULL,
        RefreshTokenExpiresAt = NULL,
        ShopCipher = NULL,
        ShopId = NULL,
        ShopName = NULL,
        SellerId = NULL,
        AuthorizedAt = NULL,
        LastSyncAt = NULL,
        LastRefreshAt = NULL,
        ConnectionStatus = N'DISCONNECTED',
        UpdatedAt = GETDATE()
      WHERE Platform = @platform
    `);

  console.log(`Cleared marketplace connection: ${platform}`);
}

function revealTokens(row) {
  return {
    accessToken: decryptToken(row.AccessToken),
    refreshToken: decryptToken(row.RefreshToken),
    accessTokenExpireAt: row.AccessTokenExpiresAt || row.AccessTokenExpireAt || null,
    refreshTokenExpireAt: row.RefreshTokenExpiresAt || row.RefreshTokenExpireAt || null,
  };
}

module.exports = {
  encryptToken,
  decryptToken,
  needsRefresh,
  needsReconnect,
  isAuthError,
  isRefreshRejected,
  reconnectRequired,
  applyRefresh,
  runWithFreshTokens,
  assertLiveToken,
  tokenMeta,
  saveTokens,
  loadTokens,
  clearTokens,
  revealTokens,
  RECONNECT_MESSAGE,
};
