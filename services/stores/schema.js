const { poolPromise, sql } = require("../../config/database");
const { repairStoredExpiry } = require("../../utils/normalize");

let ensured = false;

async function ensureSchema() {
  if (ensured) {
    return;
  }

  const pool = await poolPromise;

  await pool.request().query(`
    IF COL_LENGTH('dbo.MarketplaceOrder', 'ItemsJson') IS NULL
      ALTER TABLE dbo.MarketplaceOrder ADD ItemsJson NVARCHAR(MAX) NULL;

    IF OBJECT_ID(N'dbo.MarketplaceProduct', N'U') IS NOT NULL
    BEGIN
      IF COL_LENGTH('dbo.MarketplaceProduct', 'ImageUrl') IS NULL
        ALTER TABLE dbo.MarketplaceProduct ADD ImageUrl NVARCHAR(MAX) NULL;
      IF COL_LENGTH('dbo.MarketplaceProduct', 'VariantsJson') IS NULL
        ALTER TABLE dbo.MarketplaceProduct ADD VariantsJson NVARCHAR(MAX) NULL;
    END

    IF OBJECT_ID(N'dbo.SyncLog', N'U') IS NOT NULL
    BEGIN
      IF COL_LENGTH('dbo.SyncLog', 'MarketplaceOrderId') IS NULL
        ALTER TABLE dbo.SyncLog ADD MarketplaceOrderId NVARCHAR(100) NULL;
      IF COL_LENGTH('dbo.SyncLog', 'SapDocNum') IS NULL
        ALTER TABLE dbo.SyncLog ADD SapDocNum NVARCHAR(50) NULL;
      IF COL_LENGTH('dbo.SyncLog', 'SapDocEntry') IS NULL
        ALTER TABLE dbo.SyncLog ADD SapDocEntry NVARCHAR(50) NULL;
      IF COL_LENGTH('dbo.SyncLog', 'SyncRunId') IS NULL
        ALTER TABLE dbo.SyncLog ADD SyncRunId NVARCHAR(36) NULL;
      IF COL_LENGTH('dbo.SyncLog', 'ParentSyncRunId') IS NULL
        ALTER TABLE dbo.SyncLog ADD ParentSyncRunId NVARCHAR(36) NULL;
    END

    IF OBJECT_ID(N'dbo.MarketplaceOrder', N'U') IS NOT NULL
    BEGIN
      IF COL_LENGTH('dbo.MarketplaceOrder', 'LastSyncedAt') IS NULL
        ALTER TABLE dbo.MarketplaceOrder ADD LastSyncedAt DATETIME2 NULL;
      IF COL_LENGTH('dbo.MarketplaceOrder', 'ShopId') IS NULL
        ALTER TABLE dbo.MarketplaceOrder ADD ShopId NVARCHAR(100) NULL;
      IF COL_LENGTH('dbo.MarketplaceOrder', 'ItemAmount') IS NULL
        ALTER TABLE dbo.MarketplaceOrder ADD ItemAmount DECIMAL(18, 2) NULL;
      IF COL_LENGTH('dbo.MarketplaceOrder', 'DiscountAmount') IS NULL
        ALTER TABLE dbo.MarketplaceOrder ADD DiscountAmount DECIMAL(18, 2) NULL;
      IF COL_LENGTH('dbo.MarketplaceOrder', 'ShippingAmount') IS NULL
        ALTER TABLE dbo.MarketplaceOrder ADD ShippingAmount DECIMAL(18, 2) NULL;
      IF COL_LENGTH('dbo.MarketplaceOrder', 'PlatformStatus') IS NULL
        ALTER TABLE dbo.MarketplaceOrder ADD PlatformStatus NVARCHAR(80) NULL;
    END

    IF OBJECT_ID(N'dbo.MarketplaceConnection', N'U') IS NULL
    BEGIN
      CREATE TABLE dbo.MarketplaceConnection
      (
        ConnectionId INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
        UserId INT NULL,
        Platform NVARCHAR(50) NOT NULL,
        ShopId NVARCHAR(100) NULL,
        ShopName NVARCHAR(255) NULL,
        ShopCipher NVARCHAR(500) NULL,
        SellerId NVARCHAR(200) NULL,
        AccessToken NVARCHAR(MAX) NULL,
        RefreshToken NVARCHAR(MAX) NULL,
        AccessTokenExpiresAt DATETIME2 NULL,
        RefreshTokenExpiresAt DATETIME2 NULL,
        ConnectionStatus NVARCHAR(50) NOT NULL
          CONSTRAINT DF_MarketplaceConnection_Status DEFAULT N'CONNECTED',
        AuthorizedAt DATETIME2 NULL,
        LastRefreshAt DATETIME2 NULL,
        LastSyncAt DATETIME2 NULL,
        CreatedAt DATETIME2 NOT NULL
          CONSTRAINT DF_MarketplaceConnection_CreatedAt DEFAULT GETDATE(),
        UpdatedAt DATETIME2 NOT NULL
          CONSTRAINT DF_MarketplaceConnection_UpdatedAt DEFAULT GETDATE()
      );
    END

    IF COL_LENGTH('dbo.MarketplaceConnection', 'ShopCipher') IS NULL
      ALTER TABLE dbo.MarketplaceConnection ADD ShopCipher NVARCHAR(500) NULL;

    IF COL_LENGTH('dbo.MarketplaceConnection', 'SellerId') IS NULL
      ALTER TABLE dbo.MarketplaceConnection ADD SellerId NVARCHAR(200) NULL;

    IF COL_LENGTH('dbo.MarketplaceConnection', 'AuthorizedAt') IS NULL
      ALTER TABLE dbo.MarketplaceConnection ADD AuthorizedAt DATETIME2 NULL;

    IF COL_LENGTH('dbo.MarketplaceConnection', 'LastRefreshAt') IS NULL
      ALTER TABLE dbo.MarketplaceConnection ADD LastRefreshAt DATETIME2 NULL;

    UPDATE dbo.MarketplaceConnection
    SET AuthorizedAt = COALESCE(AuthorizedAt, CreatedAt, UpdatedAt)
    WHERE AuthorizedAt IS NULL;

    -- ลบแถวซ้ำ: เหลือแค่ ConnectionId ล่าสุดต่อ Platform (กัน TikTok/Shopee เบิ้ลจาก reconnect)
    ;WITH ranked AS (
      SELECT
        ConnectionId,
        ROW_NUMBER() OVER (
          PARTITION BY Platform
          ORDER BY UpdatedAt DESC, ConnectionId DESC
        ) AS rn
      FROM dbo.MarketplaceConnection
    )
    DELETE FROM ranked WHERE rn > 1;

    IF NOT EXISTS (
      SELECT 1
      FROM sys.indexes
      WHERE name = N'UX_MarketplaceConnection_Platform'
        AND object_id = OBJECT_ID(N'dbo.MarketplaceConnection')
    )
    BEGIN
      CREATE UNIQUE INDEX UX_MarketplaceConnection_Platform
        ON dbo.MarketplaceConnection (Platform);
    END

    -- ย้ายครั้งแรกจากตารางเก่า ถ้าตารางใหม่ยังว่าง
    IF OBJECT_ID(N'dbo.MarketplaceAuthorization', N'U') IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM dbo.MarketplaceConnection)
    BEGIN
      SET IDENTITY_INSERT dbo.MarketplaceConnection ON;

      INSERT INTO dbo.MarketplaceConnection
      (
        ConnectionId, UserId, Platform, ShopId, ShopName, ShopCipher, SellerId,
        AccessToken, RefreshToken, AccessTokenExpiresAt, RefreshTokenExpiresAt,
        ConnectionStatus, AuthorizedAt, LastRefreshAt, LastSyncAt, CreatedAt, UpdatedAt
      )
      SELECT
        a.AuthorizationId,
        a.UserId,
        a.Platform,
        a.ShopId,
        a.ShopName,
        a.ShopCipher,
        a.SellerId,
        a.AccessToken,
        a.RefreshToken,
        a.AccessTokenExpiresAt,
        a.RefreshTokenExpiresAt,
        CASE
          WHEN LOWER(ISNULL(a.Status, N'')) IN (N'connected', N'live', N'success')
            THEN N'CONNECTED'
          WHEN LOWER(ISNULL(a.Status, N'')) = N'expired'
            THEN N'EXPIRED'
          ELSE N'DISCONNECTED'
        END,
        a.AuthorizedAt,
        NULL,
        a.LastSyncAt,
        COALESCE(a.CreatedAt, a.AuthorizedAt, GETDATE()),
        COALESCE(a.UpdatedAt, a.AuthorizedAt, GETDATE())
      FROM dbo.MarketplaceAuthorization AS a;

      SET IDENTITY_INSERT dbo.MarketplaceConnection OFF;
    END

    IF OBJECT_ID(N'dbo.AppSettings', N'U') IS NULL
    BEGIN
      CREATE TABLE dbo.AppSettings
      (
        Id INT NOT NULL CONSTRAINT PK_AppSettings PRIMARY KEY,
        SettingsJson NVARCHAR(MAX) NOT NULL
          CONSTRAINT DF_AppSettings_Json DEFAULT N'{}',
        PasswordEncrypted NVARCHAR(MAX) NULL,
        ErpLastChecked DATETIME2 NULL,
        UpdatedAt DATETIME2 NOT NULL
          CONSTRAINT DF_AppSettings_UpdatedAt DEFAULT GETDATE(),
        CONSTRAINT CK_AppSettings_Singleton CHECK (Id = 1)
      );

      INSERT INTO dbo.AppSettings (Id, SettingsJson)
      VALUES (1, N'{}');
    END
  `);

  // แยก batch — CREATE INDEX บนคอลัมน์ที่เพิ่ง ADD ใน batch เดียวกันจะพัง
  await pool.request().query(`
    IF OBJECT_ID(N'dbo.MarketplaceProduct', N'U') IS NOT NULL
       AND EXISTS (
         SELECT 1
         FROM sys.columns
         WHERE object_id = OBJECT_ID(N'dbo.MarketplaceProduct')
           AND name = N'ImageUrl'
           AND max_length <> -1
       )
      ALTER TABLE dbo.MarketplaceProduct ALTER COLUMN ImageUrl NVARCHAR(MAX) NULL;
  `);

  await pool.request().query(`
    IF OBJECT_ID(N'dbo.SyncLog', N'U') IS NOT NULL
       AND COL_LENGTH('dbo.SyncLog', 'SyncRunId') IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM sys.indexes
         WHERE name = N'UX_SyncLog_SyncRunId'
           AND object_id = OBJECT_ID(N'dbo.SyncLog')
       )
    BEGIN
      CREATE UNIQUE INDEX UX_SyncLog_SyncRunId
        ON dbo.SyncLog (SyncRunId)
        WHERE SyncRunId IS NOT NULL
          AND MarketplaceOrderId IS NULL
          AND ParentSyncRunId IS NULL;
    END
  `);

  await pool.request().query(`
    UPDATE o
    SET o.ShopId = c.ShopId
    FROM dbo.MarketplaceOrder o
    INNER JOIN dbo.MarketplaceConnection c
      ON c.Platform = o.Platform
     AND UPPER(c.ConnectionStatus) = N'CONNECTED'
     AND c.ShopId IS NOT NULL
    WHERE o.ShopId IS NULL
  `);

  await repairConnectionExpiries(pool);

  ensured = true;
}

function sameInstant(next, prev) {
  if (next == null && (prev == null || prev === "")) return true;
  if (next == null || prev == null) return false;
  const left = next instanceof Date ? next.getTime() : new Date(next).getTime();
  const right = prev instanceof Date ? prev.getTime() : new Date(prev).getTime();
  return left === right;
}

async function repairConnectionExpiries(pool) {
  await pool.request().query(`
    UPDATE dbo.MarketplaceConnection
    SET LastRefreshAt = NULL
    WHERE LastRefreshAt IS NOT NULL
      AND AuthorizedAt IS NOT NULL
      AND ABS(DATEDIFF(SECOND, AuthorizedAt, LastRefreshAt)) <= 2
  `);

  const result = await pool.request().query(`
    SELECT
      ConnectionId,
      Platform,
      AccessTokenExpiresAt,
      RefreshTokenExpiresAt,
      AuthorizedAt,
      LastRefreshAt
    FROM dbo.MarketplaceConnection
  `);

  for (const row of result.recordset) {
    const anchor = row.LastRefreshAt || row.AuthorizedAt;
    const access = repairStoredExpiry(row.AccessTokenExpiresAt, anchor);
    const refresh = repairStoredExpiry(row.RefreshTokenExpiresAt, anchor);
    if (
      sameInstant(access, row.AccessTokenExpiresAt) &&
      sameInstant(refresh, row.RefreshTokenExpiresAt)
    ) {
      continue;
    }

    await pool
      .request()
      .input("id", sql.Int, row.ConnectionId)
      .input("accessExpire", sql.DateTime2, access)
      .input("refreshExpire", sql.DateTime2, refresh)
      .query(`
        UPDATE dbo.MarketplaceConnection
        SET
          AccessTokenExpiresAt = @accessExpire,
          RefreshTokenExpiresAt = @refreshExpire
        WHERE ConnectionId = @id
      `);

    console.log(
      `Repaired token expiry: ${row.Platform}` +
        ` refresh=${refresh ? refresh.toISOString() : "null"}`
    );
  }
}

module.exports = {
  ensureSchema,
};
