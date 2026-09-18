const { poolPromise } = require("../config/database");
const { ensureSchema } = require("./schema");

function variantsJson(product) {
  const list = Array.isArray(product.variants) ? product.variants : [];
  return list.length ? JSON.stringify(list) : null;
}

function parseVariants(raw) {
  if (!raw) return [];
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

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
    .input("imageUrl", product.imageUrl || null)
    .input("variantsJson", variantsJson(product))
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
          ImageUrl = COALESCE(@imageUrl, ImageUrl),
          VariantsJson = COALESCE(@variantsJson, VariantsJson),
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
          ImageUrl,
          VariantsJson,
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
          @imageUrl,
          @variantsJson,
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
      ImageUrl,
      VariantsJson,
      SyncedAt,
      SyncedAt AS UpdatedAt
    FROM dbo.MarketplaceProduct
  `;

  if (platform) {
    request.input("platform", platform);
    query += " WHERE Platform = @platform";
  }

  query += " ORDER BY SyncedAt DESC";
  const result = await request.query(query);
  return result.recordset.map((row) => {
    const variants = parseVariants(row.VariantsJson);
    const { VariantsJson, ...rest } = row;
    return {
      ...rest,
      Variants: variants,
      variants,
    };
  });
}

module.exports = {
  upsertProduct,
  listProducts,
};
