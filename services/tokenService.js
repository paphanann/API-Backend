const { poolPromise, sql } = require("../config/database");
const { encrypt, decrypt } = require("../utils/tokenCrypto");
const { ensureSchema } = require("./stores/schema");
const { currentCompanyId } = require("./stores/companyContext");
const { isPlausibleTokenExpiry } = require("../utils/normalize");

const REFRESH_SKEW_MS = 5 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const PLATFORM_REFRESH_SKEW_MS = {
  Shopee: HOUR_MS,
  Lazada: DAY_MS,
  TikTok: DAY_MS,
};

function refreshSkewMs(platform) {
  return PLATFORM_REFRESH_SKEW_MS[platform] || HOUR_MS;
}

function nextRefreshAt(platform, accessTokenExpireAt) {
  if (!accessTokenExpireAt) return null;
  const time = new Date(accessTokenExpireAt).getTime();
  if (!Number.isFinite(time)) return null;
  return new Date(time - refreshSkewMs(platform));
}

function tokenStatusFor(refreshTokenExpireAt, hasAccess) {
  if (!hasAccess) return "Expired";
  if (refreshTokenExpireAt && new Date(refreshTokenExpireAt).getTime() <= Date.now()) {
    return "Expired";
  }
  return "Active";
}

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

function keepExpiry(next, prev) {
  if (next && isPlausibleTokenExpiry(next)) return next;
  if (prev && isPlausibleTokenExpiry(prev)) return prev;
  return null;
}

async function applyRefresh(connection, payload) {
  const accessToken = payload.accessToken || "";
  if (!accessToken) {
    throw new Error("รีเฟรชโทเค็นไม่สำเร็จ ไม่ได้รับ Access Token ใหม่");
  }

  const refreshToken = payload.refreshToken || connection.refreshToken;
  const next = {
    ...connection,
    accessToken,
    refreshToken,
    accessTokenExpireAt: keepExpiry(payload.accessTokenExpireAt, connection.accessTokenExpireAt),
    refreshTokenExpireAt: keepExpiry(payload.refreshTokenExpireAt, connection.refreshTokenExpireAt),
    shopCipher: payload.shopCipher || connection.shopCipher,
  };

  await saveTokens({
    platform: next.platform,
    companyId: next.companyId,
    shopId: next.shopId,
    accessToken: next.accessToken,
    refreshToken: next.refreshToken,
    accessTokenExpireAt: next.accessTokenExpireAt,
    refreshTokenExpireAt: next.refreshTokenExpireAt,
    shopCipher: next.shopCipher,
    markRefreshed: true,
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
  companyId,
  shopId,
  accessToken,
  refreshToken,
  accessTokenExpireAt,
  refreshTokenExpireAt,
  shopCipher,
  markRefreshed = false,
}) {
  if (!accessToken) {
    throw new Error("ไม่มี Access Token ให้บันทึกลงฐานข้อมูล");
  }

  await ensureSchema();

  const key = shopKey(platform, shopId);
  const company = companyId ? String(companyId) : await currentCompanyId();
  const pool = await poolPromise;
  const sealedAccess = encryptToken(accessToken);
  const sealedRefresh = refreshToken ? encryptToken(refreshToken) : null;

  const updated = await pool
    .request()
    .input("companyId", sql.NVarChar(100), company)
    .input("platform", sql.NVarChar(50), key.platform)
    .input("shopId", sql.NVarChar(100), key.shopId)
    .input("accessToken", sql.NVarChar(sql.MAX), sealedAccess)
    .input("refreshToken", sql.NVarChar(sql.MAX), sealedRefresh)
    .input("accessExpire", sql.DateTime2, accessTokenExpireAt || null)
    .input("refreshExpire", sql.DateTime2, refreshTokenExpireAt || null)
    .input("shopCipher", sql.NVarChar(500), shopCipher || null)
    .input("markRefreshed", sql.Bit, markRefreshed ? 1 : 0)
    .input("nextRefresh", sql.DateTime2, nextRefreshAt(key.platform, accessTokenExpireAt))
    .input(
      "tokenStatus",
      sql.VarChar(30),
      tokenStatusFor(refreshTokenExpireAt, Boolean(accessToken))
    )
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

      IF @id IS NULL
      BEGIN
        RAISERROR(N'ไม่พบแถว MarketplaceConnection สำหรับร้านนี้', 16, 1);
      END

      UPDATE dbo.MarketplaceConnection
      SET
        AccessToken = @accessToken,
        RefreshToken = COALESCE(@refreshToken, RefreshToken),
        AccessTokenExpiresAt = @accessExpire,
        RefreshTokenExpiresAt = COALESCE(@refreshExpire, RefreshTokenExpiresAt),
        ShopCipher = COALESCE(@shopCipher, ShopCipher),
        ConnectionStatus = N'CONNECTED',
        LastRefreshAt = CASE WHEN @markRefreshed = 1 THEN SYSUTCDATETIME() ELSE LastRefreshAt END,
        UpdatedAt = SYSUTCDATETIME()
      WHERE ConnectionId = @id;

      DECLARE @authId INT =
      (
        SELECT TOP 1 AuthorizationId
        FROM dbo.MarketplaceAuthorization
        WHERE Platform = @platform
          AND ISNULL(ShopId, N'') = ISNULL(@shopId, N'')
        ORDER BY UpdatedAt DESC, AuthorizationId DESC
      );

      IF @authId IS NULL
      BEGIN
        INSERT INTO dbo.MarketplaceAuthorization
        (
          UserId, Platform, ShopId, ShopName, ShopCipher, SellerId,
          AccessToken, RefreshToken, AccessTokenExpiresAt, RefreshTokenExpiresAt,
          Status, Company, AuthorizedAt, LastRefreshAt, NextRefreshAt, TokenStatus, LastError,
          CreatedAt, UpdatedAt
        )
        SELECT
          COALESCE(c.UserId, 1),
          @platform,
          @shopId,
          c.ShopName,
          COALESCE(@shopCipher, c.ShopCipher),
          c.SellerId,
          @accessToken,
          COALESCE(@refreshToken, c.RefreshToken),
          @accessExpire,
          COALESCE(@refreshExpire, c.RefreshTokenExpiresAt),
          N'connected',
          LEFT(@companyId, 50),
          COALESCE(c.AuthorizedAt, SYSUTCDATETIME()),
          CASE WHEN @markRefreshed = 1 THEN SYSUTCDATETIME() ELSE c.LastRefreshAt END,
          @nextRefresh,
          @tokenStatus,
          NULL,
          SYSUTCDATETIME(),
          SYSUTCDATETIME()
        FROM dbo.MarketplaceConnection AS c
        WHERE c.ConnectionId = @id;
      END
      ELSE
      BEGIN
        UPDATE dbo.MarketplaceAuthorization
        SET
          AccessToken = @accessToken,
          RefreshToken = COALESCE(@refreshToken, RefreshToken),
          AccessTokenExpiresAt = @accessExpire,
          RefreshTokenExpiresAt = COALESCE(@refreshExpire, RefreshTokenExpiresAt),
          ShopCipher = COALESCE(@shopCipher, ShopCipher),
          Company = LEFT(@companyId, 50),
          Status = N'connected',
          TokenStatus = @tokenStatus,
          LastRefreshAt = CASE WHEN @markRefreshed = 1 THEN SYSUTCDATETIME() ELSE LastRefreshAt END,
          NextRefreshAt = @nextRefresh,
          LastError = NULL,
          UpdatedAt = SYSUTCDATETIME()
        WHERE AuthorizationId = @authId;
      END
    `);

  const rowsUpdated = Number((updated.rowsAffected && updated.rowsAffected[0]) || 0);

  const verifyResult = await pool
    .request()
    .input("companyId", sql.NVarChar(100), company)
    .input("platform", sql.NVarChar(50), key.platform)
    .input("shopId", sql.NVarChar(100), key.shopId)
    .query(`
      SELECT TOP 1
        CASE WHEN AccessToken IS NOT NULL AND LEN(AccessToken) > 0 THEN 1 ELSE 0 END AS HasAccessToken,
        CASE WHEN RefreshToken IS NOT NULL AND LEN(RefreshToken) > 0 THEN 1 ELSE 0 END AS HasRefreshToken,
        AccessTokenExpiresAt
      FROM dbo.MarketplaceConnection
      WHERE Platform = @platform
        AND ISNULL(CompanyId, N'') = ISNULL(@companyId, N'')
        AND ISNULL(ShopId, N'') = ISNULL(@shopId, N'')
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
      ` access=updated refresh=${sealedRefresh ? "updated" : "kept"}` +
      ` expire=${verify.AccessTokenExpiresAt || "-"}`
  );

  return tokenMeta(accessToken, refreshToken, accessTokenExpireAt);
}

async function loadTokens(platform, shopId) {
  await ensureSchema();

  if (!shopId) {
    return null;
  }

  const key = shopKey(platform, shopId);
  const company = await currentCompanyId();
  const pool = await poolPromise;
  const request = pool
    .request()
    .input("companyId", sql.NVarChar(100), company)
    .input("platform", sql.NVarChar(50), key.platform);

  const result = await request.input("shopId", sql.NVarChar(100), key.shopId).query(`
        SELECT TOP 1
          AccessToken,
          RefreshToken,
          AccessTokenExpiresAt,
          RefreshTokenExpiresAt,
          ShopCipher
        FROM dbo.MarketplaceConnection
        WHERE Platform = @platform
          AND ISNULL(CompanyId, N'') = ISNULL(@companyId, N'')
          AND ISNULL(ShopId, N'') = ISNULL(@shopId, N'')
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

async function clearTokens(platform, shopId) {
  await ensureSchema();
  const pool = await poolPromise;
  const request = pool
    .request()
    .input("companyId", sql.NVarChar(100), await currentCompanyId())
    .input("platform", sql.NVarChar(50), String(platform || "").trim());

  const shopFilter = shopId
    ? "AND ISNULL(ShopId, N'') = ISNULL(@shopId, N'')"
    : "";
  if (shopId) {
    request.input("shopId", sql.NVarChar(100), String(shopId));
  }

  await request.query(`
      UPDATE dbo.MarketplaceConnection
      SET
        AccessToken = NULL,
        RefreshToken = NULL,
        AccessTokenExpiresAt = NULL,
        RefreshTokenExpiresAt = NULL,
        ConnectionStatus = N'DISCONNECTED',
        UpdatedAt = SYSUTCDATETIME()
      WHERE Platform = @platform
        AND ISNULL(CompanyId, N'') = ISNULL(@companyId, N'')
        ${shopFilter};

      UPDATE dbo.MarketplaceAuthorization
      SET
        AccessToken = NULL,
        RefreshToken = NULL,
        AccessTokenExpiresAt = NULL,
        RefreshTokenExpiresAt = NULL,
        NextRefreshAt = NULL,
        Status = N'disconnected',
        TokenStatus = 'Expired',
        UpdatedAt = SYSUTCDATETIME()
      WHERE Platform = @platform
        ${shopFilter};
    `);

  console.log(`Cleared marketplace connection: ${platform}${shopId ? ` shop=${shopId}` : ""}`);
}

function revealTokens(row) {
  return {
    accessToken: decryptToken(row.AccessToken),
    refreshToken: decryptToken(row.RefreshToken),
    accessTokenExpireAt: row.AccessTokenExpiresAt || row.AccessTokenExpireAt || null,
    refreshTokenExpireAt: row.RefreshTokenExpiresAt || row.RefreshTokenExpireAt || null,
  };
}

async function markTokenState({ platform, shopId, tokenStatus, lastError }) {
  await ensureSchema();
  const key = shopKey(platform, shopId);
  const pool = await poolPromise;
  await pool
    .request()
    .input("platform", sql.NVarChar(50), key.platform)
    .input("shopId", sql.NVarChar(100), key.shopId)
    .input("tokenStatus", sql.VarChar(30), tokenStatus)
    .input("lastError", sql.NVarChar(sql.MAX), lastError || null)
    .query(`
      UPDATE dbo.MarketplaceAuthorization
      SET
        TokenStatus = @tokenStatus,
        LastError = @lastError,
        Status = CASE WHEN @tokenStatus = 'Active' THEN N'connected' ELSE N'expired' END,
        UpdatedAt = SYSUTCDATETIME()
      WHERE Platform = @platform
        AND ISNULL(ShopId, N'') = ISNULL(@shopId, N'')
    `);
}

module.exports = {
  encryptToken,
  decryptToken,
  refreshSkewMs,
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
  markTokenState,
  revealTokens,
  RECONNECT_MESSAGE,
};
