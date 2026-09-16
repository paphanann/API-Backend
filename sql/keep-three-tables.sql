USE API_Database;
GO

-- ตารางหลัก:
--   dbo.MarketplaceConnection   (เชื่อมต่อร้าน + token)
--   dbo.MarketplaceOrder        (ออเดอร์ + รายการสินค้าใน ItemsJson)
--   dbo.MarketplaceProduct      (สินค้า)

IF COL_LENGTH('dbo.MarketplaceOrder', 'ItemsJson') IS NULL
  ALTER TABLE dbo.MarketplaceOrder ADD ItemsJson NVARCHAR(MAX) NULL;
GO

IF OBJECT_ID(N'dbo.FK_SyncLog_MarketplaceConnection', N'F') IS NOT NULL
  ALTER TABLE dbo.SyncLog DROP CONSTRAINT FK_SyncLog_MarketplaceConnection;
GO

IF OBJECT_ID(N'dbo.MarketplaceOrderItem', N'U') IS NOT NULL
  DROP TABLE dbo.MarketplaceOrderItem;
GO

-- MarketplaceAuthorization เป็นตารางเก่า — คงไว้เป็น backup ไม่ลบอัตโนมัติ
-- ใช้ dbo.MarketplaceConnection เป็นตารางหลักแทน
GO
