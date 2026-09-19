const { poolPromise } = require("../../config/database");

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
        ALTER TABLE dbo.MarketplaceProduct ADD ImageUrl NVARCHAR(1000) NULL;
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
  `);

  ensured = true;
}

module.exports = {
  ensureSchema,
};
