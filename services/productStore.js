const { poolPromise } = require("../config/database");
const { ensureSchema } = require("./schema");

async function upsertProduct(product) {
  await ensureSchema();
  const pool = await poolPromise;

  await pool
    .request()
    .input("platform", product.platform)
    .input("productId", String(product.productId))
    .input("sku", product.sku || null)
    .input("name", product.name || null)
    .input("price", product.price)
    .input("stock", product.stock)
    .input("status", product.status || null)
    .query(`
      IF EXISTS (
        SELECT 1
        FROM dbo.MarketplaceProduct
        WHERE Platform = @platform
          AND ProductId = @productId
      )
      BEGIN
        UPDATE dbo.MarketplaceProduct
        SET
          Sku = @sku,
          Name = @name,
          Price = @price,
          Stock = @stock,
          Status = @status,
          SyncedAt = GETDATE()
        WHERE Platform = @platform
          AND ProductId = @productId
      END
      ELSE
      BEGIN
        INSERT INTO dbo.MarketplaceProduct
        (
          Platform,
          ProductId,
          Sku,
          Name,
          Price,
          Stock,
          Status,
          SyncedAt
        )
        VALUES
        (
          @platform,
          @productId,
          @sku,
          @name,
          @price,
          @stock,
          @status,
          GETDATE()
        )
      END
    `);
}

async function listProducts(platform) {
  await ensureSchema();
  const pool = await poolPromise;
  const request = pool.request();

  let query = `
    SELECT
      Id,
      Platform,
      ProductId,
      Sku,
      Name,
      Price,
      Stock,
      Status,
      SyncedAt
    FROM dbo.MarketplaceProduct
  `;

  if (platform) {
    request.input("platform", platform);
    query += " WHERE Platform = @platform";
  }

  query += " ORDER BY SyncedAt DESC";
  const result = await request.query(query);
  return result.recordset;
}

module.exports = {
  upsertProduct,
  listProducts,
};
