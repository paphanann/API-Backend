USE master;
GO

IF DB_ID(N'API_Database') IS NULL
BEGIN
  CREATE DATABASE API_Database;
END
GO

USE API_Database;
GO

IF OBJECT_ID(N'dbo.AppUser', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.AppUser
  (
    Id            INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    Email         NVARCHAR(255) NOT NULL,
    Username      NVARCHAR(100) NOT NULL,
    Name          NVARCHAR(200) NOT NULL,
    PasswordHash  NVARCHAR(255) NOT NULL,
    CreatedAt     DATETIME NOT NULL CONSTRAINT DF_AppUser_CreatedAt DEFAULT GETDATE(),
    CONSTRAINT UQ_AppUser_Email UNIQUE (Email),
    CONSTRAINT UQ_AppUser_Username UNIQUE (Username)
  );
END
GO

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
    LastRefreshAt DATETIME2 NULL,
    LastSyncAt DATETIME2 NULL,
    CreatedAt DATETIME2 NOT NULL
      CONSTRAINT DF_MarketplaceConnection_CreatedAt DEFAULT SYSUTCDATETIME(),
    UpdatedAt DATETIME2 NOT NULL
      CONSTRAINT DF_MarketplaceConnection_UpdatedAt DEFAULT SYSUTCDATETIME()
  );
END
GO

IF OBJECT_ID(N'dbo.MarketplaceAuthorization', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.MarketplaceAuthorization
  (
    Id                    INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    Platform              NVARCHAR(50) NOT NULL,
    ShopId                NVARCHAR(100) NULL,
    ShopName              NVARCHAR(255) NULL,
    ShopCipher            NVARCHAR(500) NULL,
    OpenId                NVARCHAR(200) NULL,
    AccessToken           NVARCHAR(MAX) NULL,
    RefreshToken          NVARCHAR(MAX) NULL,
    AccessTokenExpireAt   DATETIME NULL,
    RefreshTokenExpireAt  DATETIME NULL,
    Status                NVARCHAR(50) NOT NULL CONSTRAINT DF_MarketplaceAuthorization_Status DEFAULT N'disconnected',
    AuthorizedAt          DATETIME NULL,
    LastSyncAt            DATETIME NULL,
    UpdatedAt             DATETIME NULL
  );
END
GO

IF OBJECT_ID(N'dbo.MarketplaceOrder', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.MarketplaceOrder
  (
    Id                   INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    Platform             NVARCHAR(50) NOT NULL,
    MarketplaceOrderId   NVARCHAR(100) NOT NULL,
    CustomerName         NVARCHAR(255) NULL,
    CustomerPhone        NVARCHAR(50) NULL,
    ShippingAddress      NVARCHAR(500) NULL,
    OrderDate            DATETIME NULL,
    OrderStatus          NVARCHAR(50) NULL,
    PaymentMethod        NVARCHAR(100) NULL,
    ShippingMethod       NVARCHAR(100) NULL,
    TotalAmount          DECIMAL(18,2) NULL,
    Currency             NVARCHAR(10) NULL,
    SyncStatus           NVARCHAR(50) NULL,
    SapDocNum            NVARCHAR(50) NULL,
    ItemsJson            NVARCHAR(MAX) NULL
  );
END
GO

IF COL_LENGTH('dbo.MarketplaceOrder', 'ItemsJson') IS NULL
  ALTER TABLE dbo.MarketplaceOrder ADD ItemsJson NVARCHAR(MAX) NULL;
GO

IF OBJECT_ID(N'dbo.MarketplaceProduct', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.MarketplaceProduct
  (
    Id              INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    Platform        NVARCHAR(50) NOT NULL,
    ProductId       NVARCHAR(100) NOT NULL,
    Sku             NVARCHAR(100) NULL,
    Name            NVARCHAR(255) NULL,
    Price           DECIMAL(18,2) NULL,
    Stock           INT NULL,
    Status          NVARCHAR(50) NULL,
    SyncedAt        DATETIME NULL
  );
END
GO
