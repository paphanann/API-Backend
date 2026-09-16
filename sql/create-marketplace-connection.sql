USE API_Database;
GO

-- ตารางหลัก: เชื่อมต่อร้าน + เก็บ Access/Refresh Token
IF OBJECT_ID(N'dbo.MarketplaceConnection', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.MarketplaceConnection
  (
    ConnectionId INT IDENTITY(1,1) NOT NULL PRIMARY KEY,

    UserId INT NULL,

    Platform NVARCHAR(50) NOT NULL,

    ShopId NVARCHAR(100) NULL,
    ShopName NVARCHAR(255) NULL,
    -- คงไว้สำหรับ TikTok / Lazada
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
      CONSTRAINT DF_MarketplaceConnection_CreatedAt DEFAULT SYSUTCDATETIME(),

    UpdatedAt DATETIME2 NOT NULL
      CONSTRAINT DF_MarketplaceConnection_UpdatedAt DEFAULT SYSUTCDATETIME()
  );

  CREATE UNIQUE INDEX UX_MarketplaceConnection_Platform_ShopId
    ON dbo.MarketplaceConnection (Platform, ShopId)
    WHERE ShopId IS NOT NULL;
END
GO

IF COL_LENGTH('dbo.MarketplaceConnection', 'AuthorizedAt') IS NULL
  ALTER TABLE dbo.MarketplaceConnection ADD AuthorizedAt DATETIME2 NULL;
GO

IF COL_LENGTH('dbo.MarketplaceConnection', 'ShopCipher') IS NULL
  ALTER TABLE dbo.MarketplaceConnection ADD ShopCipher NVARCHAR(500) NULL;
GO

IF COL_LENGTH('dbo.MarketplaceConnection', 'SellerId') IS NULL
  ALTER TABLE dbo.MarketplaceConnection ADD SellerId NVARCHAR(200) NULL;
GO

UPDATE dbo.MarketplaceConnection
SET AuthorizedAt = COALESCE(AuthorizedAt, CreatedAt, UpdatedAt)
WHERE AuthorizedAt IS NULL;
GO

-- ย้ายข้อมูลจาก MarketplaceAuthorization (ถ้ามี และตารางใหม่ยังว่าง)
IF OBJECT_ID(N'dbo.MarketplaceAuthorization', N'U') IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM dbo.MarketplaceConnection)
BEGIN
  SET IDENTITY_INSERT dbo.MarketplaceConnection ON;

  INSERT INTO dbo.MarketplaceConnection
  (
    ConnectionId,
    UserId,
    Platform,
    ShopId,
    ShopName,
    ShopCipher,
    SellerId,
    AccessToken,
    RefreshToken,
    AccessTokenExpiresAt,
    RefreshTokenExpiresAt,
    ConnectionStatus,
    AuthorizedAt,
    LastRefreshAt,
    LastSyncAt,
    CreatedAt,
    UpdatedAt
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
      WHEN LOWER(ISNULL(a.Status, N'')) IN (N'expired')
        THEN N'EXPIRED'
      ELSE N'DISCONNECTED'
    END,
    a.AuthorizedAt,
    NULL,
    a.LastSyncAt,
    COALESCE(a.CreatedAt, a.AuthorizedAt, SYSUTCDATETIME()),
    COALESCE(a.UpdatedAt, a.AuthorizedAt, SYSUTCDATETIME())
  FROM dbo.MarketplaceAuthorization AS a;

  SET IDENTITY_INSERT dbo.MarketplaceConnection OFF;
END
GO
