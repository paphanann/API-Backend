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
      IF COL_LENGTH('dbo.MarketplaceProduct', 'ShopId') IS NULL
        ALTER TABLE dbo.MarketplaceProduct ADD ShopId NVARCHAR(100) NULL;
      IF COL_LENGTH('dbo.MarketplaceProduct', 'CompanyId') IS NULL
        ALTER TABLE dbo.MarketplaceProduct ADD CompanyId NVARCHAR(100) NULL;
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
      IF COL_LENGTH('dbo.MarketplaceOrder', 'CompanyId') IS NULL
        ALTER TABLE dbo.MarketplaceOrder ADD CompanyId NVARCHAR(100) NULL;
      IF COL_LENGTH('dbo.MarketplaceOrder', 'ItemAmount') IS NULL
        ALTER TABLE dbo.MarketplaceOrder ADD ItemAmount DECIMAL(18, 2) NULL;
      IF COL_LENGTH('dbo.MarketplaceOrder', 'DiscountAmount') IS NULL
        ALTER TABLE dbo.MarketplaceOrder ADD DiscountAmount DECIMAL(18, 2) NULL;
      IF COL_LENGTH('dbo.MarketplaceOrder', 'ShippingAmount') IS NULL
        ALTER TABLE dbo.MarketplaceOrder ADD ShippingAmount DECIMAL(18, 2) NULL;
      IF COL_LENGTH('dbo.MarketplaceOrder', 'PlatformStatus') IS NULL
        ALTER TABLE dbo.MarketplaceOrder ADD PlatformStatus NVARCHAR(80) NULL;
      IF COL_LENGTH('dbo.MarketplaceOrder', 'ShopName') IS NULL
        ALTER TABLE dbo.MarketplaceOrder ADD ShopName NVARCHAR(255) NULL;
      IF COL_LENGTH('dbo.MarketplaceOrder', 'CustomerEmail') IS NULL
        ALTER TABLE dbo.MarketplaceOrder ADD CustomerEmail NVARCHAR(120) NULL;
      IF COL_LENGTH('dbo.MarketplaceOrder', 'TrackingNo') IS NULL
        ALTER TABLE dbo.MarketplaceOrder ADD TrackingNo NVARCHAR(50) NULL;
      IF COL_LENGTH('dbo.MarketplaceOrder', 'DeliveryDocNum') IS NULL
        ALTER TABLE dbo.MarketplaceOrder ADD DeliveryDocNum NVARCHAR(50) NULL;
      IF COL_LENGTH('dbo.MarketplaceOrder', 'ReturnRequestDocNum') IS NULL
        ALTER TABLE dbo.MarketplaceOrder ADD ReturnRequestDocNum NVARCHAR(50) NULL;
    END

    IF OBJECT_ID(N'dbo.MarketplaceOrder', N'U') IS NOT NULL
       AND OBJECT_ID(N'dbo.MarketplaceConnection', N'U') IS NOT NULL
       AND COL_LENGTH('dbo.MarketplaceOrder', 'ShopName') IS NOT NULL
    BEGIN
      EXEC(N'
        UPDATE o
        SET ShopName = c.ShopName
        FROM dbo.MarketplaceOrder o
        INNER JOIN dbo.MarketplaceConnection c
          ON c.Platform COLLATE DATABASE_DEFAULT = o.Platform COLLATE DATABASE_DEFAULT
         AND ISNULL(c.CompanyId, N'''') COLLATE DATABASE_DEFAULT = ISNULL(o.CompanyId, N'''') COLLATE DATABASE_DEFAULT
         AND ISNULL(c.ShopId, N'''') COLLATE DATABASE_DEFAULT = ISNULL(o.ShopId, N'''') COLLATE DATABASE_DEFAULT
        WHERE c.ShopName IS NOT NULL
          AND ISNULL(o.ShopName, N'''') = N''''
      ');
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

    IF COL_LENGTH('dbo.MarketplaceConnection', 'CompanyId') IS NULL
      ALTER TABLE dbo.MarketplaceConnection ADD CompanyId NVARCHAR(100) NULL;

    IF COL_LENGTH('dbo.MarketplaceConnection', 'LastRefreshAt') IS NULL
      ALTER TABLE dbo.MarketplaceConnection ADD LastRefreshAt DATETIME2 NULL;

    UPDATE dbo.MarketplaceConnection
    SET AuthorizedAt = COALESCE(AuthorizedAt, CreatedAt, UpdatedAt)
    WHERE AuthorizedAt IS NULL;

    -- ดัชนีไม่ซ้ำของร้านย้ายไปคู่ CompanyId + Platform + ShopId ในแบตช์ถัดไป
    IF EXISTS (
      SELECT 1
      FROM sys.indexes
      WHERE name = N'UX_MarketplaceConnection_Platform'
        AND object_id = OBJECT_ID(N'dbo.MarketplaceConnection')
    )
    BEGIN
      DROP INDEX UX_MarketplaceConnection_Platform ON dbo.MarketplaceConnection;
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
    DECLARE @company NVARCHAR(100);
    SELECT @company = COALESCE(
      NULLIF(LTRIM(RTRIM(JSON_VALUE(SettingsJson, '$.companyCode'))), N''),
      NULLIF(LTRIM(RTRIM(JSON_VALUE(SettingsJson, '$.database'))), N''),
      N'default'
    )
    FROM dbo.AppSettings
    WHERE Id = 1;
    IF @company IS NULL SET @company = N'default';

    IF COL_LENGTH('dbo.MarketplaceConnection', 'CompanyId') IS NOT NULL
      UPDATE dbo.MarketplaceConnection SET CompanyId = @company WHERE CompanyId IS NULL;
    IF COL_LENGTH('dbo.MarketplaceOrder', 'CompanyId') IS NOT NULL
      UPDATE dbo.MarketplaceOrder SET CompanyId = @company WHERE CompanyId IS NULL;
    IF COL_LENGTH('dbo.MarketplaceProduct', 'CompanyId') IS NOT NULL
      UPDATE dbo.MarketplaceProduct SET CompanyId = @company WHERE CompanyId IS NULL;

    IF EXISTS (
      SELECT 1 FROM sys.indexes
      WHERE name = N'UX_MarketplaceConnection_Platform_ShopId'
        AND object_id = OBJECT_ID(N'dbo.MarketplaceConnection')
    )
      DROP INDEX UX_MarketplaceConnection_Platform_ShopId ON dbo.MarketplaceConnection;

    IF OBJECT_ID(N'dbo.MarketplaceConnection', N'U') IS NOT NULL
       AND COL_LENGTH('dbo.MarketplaceConnection', 'CompanyId') IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM sys.indexes
         WHERE name = N'UX_MarketplaceConnection_Company_Platform_Shop'
           AND object_id = OBJECT_ID(N'dbo.MarketplaceConnection')
       )
      CREATE UNIQUE INDEX UX_MarketplaceConnection_Company_Platform_Shop
        ON dbo.MarketplaceConnection (CompanyId, Platform, ShopId)
        WHERE CompanyId IS NOT NULL AND ShopId IS NOT NULL;
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
      ON c.Platform COLLATE DATABASE_DEFAULT = o.Platform COLLATE DATABASE_DEFAULT
     AND UPPER(c.ConnectionStatus) = N'CONNECTED'
     AND c.ShopId IS NOT NULL
    WHERE o.ShopId IS NULL
      AND (
        SELECT COUNT(*)
        FROM dbo.MarketplaceConnection c2
        WHERE c2.Platform COLLATE DATABASE_DEFAULT = o.Platform COLLATE DATABASE_DEFAULT
          AND UPPER(c2.ConnectionStatus) = N'CONNECTED'
          AND c2.ShopId IS NOT NULL
      ) = 1
  `);

  await pool.request().query(`
    IF OBJECT_ID(N'dbo.MarketplaceOrder', N'U') IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM sys.indexes
         WHERE name = N'IX_MarketplaceOrder_Platform_OrderId'
           AND object_id = OBJECT_ID(N'dbo.MarketplaceOrder')
       )
      CREATE INDEX IX_MarketplaceOrder_Platform_OrderId
        ON dbo.MarketplaceOrder (Platform, MarketplaceOrderId, ShopId);

    IF OBJECT_ID(N'dbo.MarketplaceOrder', N'U') IS NOT NULL
       AND COL_LENGTH('dbo.MarketplaceOrder', 'CompanyId') IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM sys.indexes
         WHERE name = N'UX_MarketplaceOrder_Company_Platform_Shop_Order'
           AND object_id = OBJECT_ID(N'dbo.MarketplaceOrder')
       )
      CREATE UNIQUE INDEX UX_MarketplaceOrder_Company_Platform_Shop_Order
        ON dbo.MarketplaceOrder (CompanyId, Platform, ShopId, MarketplaceOrderId)
        WHERE CompanyId IS NOT NULL AND ShopId IS NOT NULL AND MarketplaceOrderId IS NOT NULL;

    IF OBJECT_ID(N'dbo.MarketplaceOrder', N'U') IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM sys.indexes
         WHERE name = N'IX_MarketplaceOrder_OrderDate'
           AND object_id = OBJECT_ID(N'dbo.MarketplaceOrder')
       )
      CREATE INDEX IX_MarketplaceOrder_OrderDate
        ON dbo.MarketplaceOrder (OrderDate DESC);

    IF OBJECT_ID(N'dbo.MarketplaceConnection', N'U') IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM sys.indexes
         WHERE name = N'IX_MarketplaceConnection_LastSyncAt'
           AND object_id = OBJECT_ID(N'dbo.MarketplaceConnection')
       )
      CREATE INDEX IX_MarketplaceConnection_LastSyncAt
        ON dbo.MarketplaceConnection (LastSyncAt);

    IF OBJECT_ID(N'dbo.SyncLog', N'U') IS NOT NULL
       AND COL_LENGTH('dbo.SyncLog', 'StartTime') IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM sys.indexes
         WHERE name = N'IX_SyncLog_StartTime'
           AND object_id = OBJECT_ID(N'dbo.SyncLog')
       )
      CREATE INDEX IX_SyncLog_StartTime
        ON dbo.SyncLog (StartTime DESC);

    IF OBJECT_ID(N'dbo.SyncLog', N'U') IS NOT NULL
       AND COL_LENGTH('dbo.SyncLog', 'ParentSyncRunId') IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM sys.indexes
         WHERE name = N'IX_SyncLog_Parent'
           AND object_id = OBJECT_ID(N'dbo.SyncLog')
       )
      CREATE INDEX IX_SyncLog_Parent
        ON dbo.SyncLog (ParentSyncRunId, Status);

    IF OBJECT_ID(N'dbo.MarketplaceProduct', N'U') IS NOT NULL
       AND COL_LENGTH('dbo.MarketplaceProduct', 'ShopId') IS NOT NULL
    BEGIN
      UPDATE p
      SET p.ShopId = c.ShopId
      FROM dbo.MarketplaceProduct p
      INNER JOIN dbo.MarketplaceConnection c
        ON c.Platform COLLATE DATABASE_DEFAULT = p.Platform COLLATE DATABASE_DEFAULT
       AND c.ShopId IS NOT NULL
      WHERE p.ShopId IS NULL
        AND (
          SELECT COUNT(*)
          FROM dbo.MarketplaceConnection c2
          WHERE c2.Platform COLLATE DATABASE_DEFAULT = p.Platform COLLATE DATABASE_DEFAULT
            AND c2.ShopId IS NOT NULL
        ) = 1;
    END

    IF OBJECT_ID(N'dbo.MarketplaceProduct', N'U') IS NOT NULL
       AND COL_LENGTH('dbo.MarketplaceProduct', 'ShopId') IS NOT NULL
       AND COL_LENGTH('dbo.MarketplaceConnection', 'ShopId') IS NOT NULL
    BEGIN
      DECLARE @shopCollation sysname;
      DECLARE @productShopCollation sysname;
      SELECT @shopCollation = collation_name
      FROM sys.columns
      WHERE object_id = OBJECT_ID(N'dbo.MarketplaceConnection')
        AND name = N'ShopId';
      SELECT @productShopCollation = collation_name
      FROM sys.columns
      WHERE object_id = OBJECT_ID(N'dbo.MarketplaceProduct')
        AND name = N'ShopId';

      IF @shopCollation IS NOT NULL
         AND @productShopCollation IS NOT NULL
         AND @shopCollation <> @productShopCollation
      BEGIN
        IF EXISTS (
          SELECT 1 FROM sys.indexes
          WHERE name = N'IX_MarketplaceProduct_Platform_Shop_Product'
            AND object_id = OBJECT_ID(N'dbo.MarketplaceProduct')
        )
          DROP INDEX IX_MarketplaceProduct_Platform_Shop_Product ON dbo.MarketplaceProduct;

        DECLARE @alignShop nvarchar(400) =
          N'ALTER TABLE dbo.MarketplaceProduct ALTER COLUMN ShopId NVARCHAR(100) COLLATE '
          + @shopCollation + N' NULL';
        EXEC sp_executesql @alignShop;
      END
    END

    IF OBJECT_ID(N'dbo.MarketplaceProduct', N'U') IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM sys.indexes
         WHERE name = N'IX_MarketplaceProduct_Platform_Shop_Product'
           AND object_id = OBJECT_ID(N'dbo.MarketplaceProduct')
       )
      CREATE INDEX IX_MarketplaceProduct_Platform_Shop_Product
        ON dbo.MarketplaceProduct (Platform, ShopId, ProductId);

    IF OBJECT_ID(N'dbo.MarketplaceProduct', N'U') IS NOT NULL
       AND COL_LENGTH('dbo.MarketplaceProduct', 'CompanyId') IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM sys.indexes
         WHERE name = N'UX_MarketplaceProduct_Company_Platform_Shop_Product'
           AND object_id = OBJECT_ID(N'dbo.MarketplaceProduct')
       )
      CREATE UNIQUE INDEX UX_MarketplaceProduct_Company_Platform_Shop_Product
        ON dbo.MarketplaceProduct (CompanyId, Platform, ShopId, ProductId)
        WHERE CompanyId IS NOT NULL AND ShopId IS NOT NULL AND ProductId IS NOT NULL;

    IF COL_LENGTH('dbo.MarketplaceConnection', 'WarehouseCode') IS NULL
      ALTER TABLE dbo.MarketplaceConnection ADD WarehouseCode NVARCHAR(50) NULL;

    IF OBJECT_ID(N'dbo.StockTransfer', N'U') IS NULL
    BEGIN
      CREATE TABLE dbo.StockTransfer
      (
        Id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
        CompanyId NVARCHAR(100) NULL,
        DocumentNo NVARCHAR(100) NOT NULL,
        Platform NVARCHAR(50) NULL,
        FromWarehouse NVARCHAR(50) NOT NULL,
        ToWarehouse NVARCHAR(50) NOT NULL,
        Status NVARCHAR(20) NOT NULL,
        SapDocNum NVARCHAR(50) NULL,
        SapDocEntry NVARCHAR(50) NULL,
        RequestedBy NVARCHAR(100) NULL,
        Note NVARCHAR(254) NULL,
        ReferenceNo NVARCHAR(254) NULL,
        NumAtCard NVARCHAR(100) NULL,
        DueDate DATETIME NULL,
        ErrorMessage NVARCHAR(500) NULL,
        CreatedAt DATETIME2 NOT NULL CONSTRAINT DF_StockTransfer_CreatedAt DEFAULT GETDATE(),
        UpdatedAt DATETIME2 NOT NULL CONSTRAINT DF_StockTransfer_UpdatedAt DEFAULT GETDATE()
      );
    END

    IF OBJECT_ID(N'dbo.StockTransferLine', N'U') IS NULL
    BEGIN
      CREATE TABLE dbo.StockTransferLine
      (
        Id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
        TransferId INT NOT NULL,
        Sku NVARCHAR(100) NOT NULL,
        SapItemCode NVARCHAR(50) NULL,
        Qty DECIMAL(18, 4) NOT NULL,
        Name NVARCHAR(255) NULL
      );
    END

    IF OBJECT_ID(N'dbo.StockTransferOrder', N'U') IS NULL
    BEGIN
      CREATE TABLE dbo.StockTransferOrder
      (
        Id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
        TransferId INT NOT NULL,
        SalesOrderId NVARCHAR(100) NOT NULL
      );
    END
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

  await moveShopNameBesidePlatform(pool);
  await alignOrderKeyCollation(pool);
}

async function moveShopNameBesidePlatform(pool) {
  const pos = await pool.request().query(`
    SELECT name, column_id
    FROM sys.columns
    WHERE object_id = OBJECT_ID(N'dbo.MarketplaceOrder')
      AND name IN (N'Platform', N'ShopName')
  `);
  const platform = pos.recordset.find((row) => row.name === "Platform");
  const shop = pos.recordset.find((row) => row.name === "ShopName");
  if (!platform || !shop || Number(shop.column_id) === Number(platform.column_id) + 1) {
    return;
  }

  const before = await pool.request().query(`SELECT COUNT(1) AS n FROM dbo.MarketplaceOrder`);
  const expected = before.recordset[0].n;

  await pool.request().query(`
    IF OBJECT_ID(N'dbo.MarketplaceOrder_Reorder', N'U') IS NOT NULL
      DROP TABLE dbo.MarketplaceOrder_Reorder;

    CREATE TABLE dbo.MarketplaceOrder_Reorder
    (
      Id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
      Platform NVARCHAR(50) NOT NULL,
      ShopName NVARCHAR(255) NULL,
      MarketplaceOrderId NVARCHAR(100) NOT NULL,
      CustomerName NVARCHAR(255) NULL,
      OrderDate DATETIME NULL,
      OrderStatus NVARCHAR(50) NULL,
      TotalAmount DECIMAL(18, 2) NULL,
      Currency NVARCHAR(10) NULL,
      SyncStatus NVARCHAR(50) NULL,
      SapDocNum NVARCHAR(50) NULL,
      CustomerPhone NVARCHAR(50) NULL,
      ShippingAddress NVARCHAR(500) NULL,
      PaymentMethod NVARCHAR(100) NULL,
      ShippingMethod NVARCHAR(100) NULL,
      ItemsJson NVARCHAR(MAX) NULL,
      LastSyncedAt DATETIME2 NULL,
      ShopId NVARCHAR(100) NULL,
      ItemAmount DECIMAL(18, 2) NULL,
      DiscountAmount DECIMAL(18, 2) NULL,
      ShippingAmount DECIMAL(18, 2) NULL,
      PlatformStatus NVARCHAR(80) NULL,
      CompanyId NVARCHAR(100) NULL
    );
  `);

  await pool.request().query(`
    SET IDENTITY_INSERT dbo.MarketplaceOrder_Reorder ON;
    INSERT INTO dbo.MarketplaceOrder_Reorder (
      Id, Platform, ShopName, MarketplaceOrderId, CustomerName, OrderDate, OrderStatus,
      TotalAmount, Currency, SyncStatus, SapDocNum, CustomerPhone, ShippingAddress,
      PaymentMethod, ShippingMethod, ItemsJson, LastSyncedAt, ShopId, ItemAmount,
      DiscountAmount, ShippingAmount, PlatformStatus, CompanyId
    )
    SELECT
      Id, Platform, ShopName, MarketplaceOrderId, CustomerName, OrderDate, OrderStatus,
      TotalAmount, Currency, SyncStatus, SapDocNum, CustomerPhone, ShippingAddress,
      PaymentMethod, ShippingMethod, ItemsJson, LastSyncedAt, ShopId, ItemAmount,
      DiscountAmount, ShippingAmount, PlatformStatus, CompanyId
    FROM dbo.MarketplaceOrder;
    SET IDENTITY_INSERT dbo.MarketplaceOrder_Reorder OFF;
  `);

  const copied = await pool.request().query(`SELECT COUNT(1) AS n FROM dbo.MarketplaceOrder_Reorder`);
  if (copied.recordset[0].n !== expected) {
    await pool.request().query(`DROP TABLE dbo.MarketplaceOrder_Reorder`);
    throw new Error(`ย้ายคอลัมน์ ShopName ไม่ครบ ${copied.recordset[0].n}/${expected}`);
  }

  await pool.request().query(`
    DROP TABLE dbo.MarketplaceOrder;
    EXEC sp_rename N'dbo.MarketplaceOrder_Reorder', N'MarketplaceOrder';

    CREATE INDEX IX_MarketplaceOrder_Platform_OrderId
      ON dbo.MarketplaceOrder (Platform, MarketplaceOrderId, ShopId);
    CREATE UNIQUE INDEX UX_MarketplaceOrder_Company_Platform_Shop_Order
      ON dbo.MarketplaceOrder (CompanyId, Platform, ShopId, MarketplaceOrderId)
      WHERE CompanyId IS NOT NULL AND ShopId IS NOT NULL AND MarketplaceOrderId IS NOT NULL;
    CREATE INDEX IX_MarketplaceOrder_OrderDate
      ON dbo.MarketplaceOrder (OrderDate DESC);
    DBCC CHECKIDENT (N'dbo.MarketplaceOrder', RESEED);
  `);
}

async function alignOrderKeyCollation(pool) {
  const row = await pool.request().query(`
    SELECT collation_name
    FROM sys.columns
    WHERE object_id = OBJECT_ID(N'dbo.MarketplaceOrder')
      AND name = N'Platform'
  `);
  const current = row.recordset[0] && row.recordset[0].collation_name;
  if (!current || current === "SQL_Latin1_General_CP850_CI_AS") return;

  await pool.request().query(`
    IF EXISTS (
      SELECT 1 FROM sys.indexes
      WHERE name = N'IX_MarketplaceOrder_Platform_OrderId'
        AND object_id = OBJECT_ID(N'dbo.MarketplaceOrder')
    )
      DROP INDEX IX_MarketplaceOrder_Platform_OrderId ON dbo.MarketplaceOrder;

    IF EXISTS (
      SELECT 1 FROM sys.indexes
      WHERE name = N'UX_MarketplaceOrder_Company_Platform_Shop_Order'
        AND object_id = OBJECT_ID(N'dbo.MarketplaceOrder')
    )
      DROP INDEX UX_MarketplaceOrder_Company_Platform_Shop_Order ON dbo.MarketplaceOrder;

    ALTER TABLE dbo.MarketplaceOrder ALTER COLUMN Platform NVARCHAR(50) COLLATE SQL_Latin1_General_CP850_CI_AS NOT NULL;
    ALTER TABLE dbo.MarketplaceOrder ALTER COLUMN ShopName NVARCHAR(255) COLLATE SQL_Latin1_General_CP850_CI_AS NULL;
    ALTER TABLE dbo.MarketplaceOrder ALTER COLUMN MarketplaceOrderId NVARCHAR(100) COLLATE SQL_Latin1_General_CP850_CI_AS NOT NULL;
    ALTER TABLE dbo.MarketplaceOrder ALTER COLUMN ShopId NVARCHAR(100) COLLATE SQL_Latin1_General_CP850_CI_AS NULL;

    CREATE INDEX IX_MarketplaceOrder_Platform_OrderId
      ON dbo.MarketplaceOrder (Platform, MarketplaceOrderId, ShopId);
    CREATE UNIQUE INDEX UX_MarketplaceOrder_Company_Platform_Shop_Order
      ON dbo.MarketplaceOrder (CompanyId, Platform, ShopId, MarketplaceOrderId)
      WHERE CompanyId IS NOT NULL AND ShopId IS NOT NULL AND MarketplaceOrderId IS NOT NULL;
  `);
}

module.exports = {
  ensureSchema,
};
