const { poolPromise } = require("../../config/database");
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

async function deleteProduct(platform, productId) {
  await ensureSchema();
  const pool = await poolPromise;
  await pool
    .request()
    .input("platform", platform)
    .input("productId", String(productId))
    .query(`
      DELETE FROM dbo.MarketplaceProduct
      WHERE Platform = @platform
        AND ProductId = @productId
    `);
}

/** ลบสินค้าที่ปิดขาย/ฉบับร่างของแพลตฟอร์ม */
async function deleteNonActive(platform) {
  await ensureSchema();
  const pool = await poolPromise;
  const result = await pool
    .request()
    .input("platform", platform)
    .query(`
      DELETE FROM dbo.MarketplaceProduct
      WHERE Platform = @platform
        AND (
          Status IS NULL
          OR LOWER(Status) NOT IN (N'active', N'normal', N'activate')
        );
      SELECT @@ROWCOUNT AS Deleted;
    `);
  const row = result.recordset && result.recordset[0];
  return Number(row && row.Deleted) || 0;
}

/**
 * หลัง sync แคตตาล็อกเต็ม: ลบสินค้าของแพลตฟอร์มที่ไม่อยู่ในรายการที่ยังขาย
 * @param {string} platform
 * @param {string[]} keepProductIds
 */
async function deleteMissing(platform, keepProductIds) {
  await ensureSchema();
  const pool = await poolPromise;
  const keep = [...new Set((keepProductIds || []).map((id) => String(id)).filter(Boolean))];

  if (!keep.length) {
    const result = await pool
      .request()
      .input("platform", platform)
      .query(`
        DELETE FROM dbo.MarketplaceProduct WHERE Platform = @platform;
        SELECT @@ROWCOUNT AS Deleted;
      `);
    return Number(result.recordset && result.recordset[0] && result.recordset[0].Deleted) || 0;
  }

  // สร้างตารางชั่วคราวของ id ที่เก็บไว้ แล้วลบตัวที่ไม่อยู่ในนั้น
  const tvpValues = keep.map((_, i) => `(@id${i})`).join(",");
  const req = pool.request().input("platform", platform);
  keep.forEach((id, i) => req.input(`id${i}`, id));

  const result = await req.query(`
    DECLARE @Keep TABLE (ProductId NVARCHAR(128) PRIMARY KEY);
    INSERT INTO @Keep (ProductId) VALUES ${tvpValues};

    DELETE p
    FROM dbo.MarketplaceProduct p
    WHERE p.Platform = @platform
      AND NOT EXISTS (
        SELECT 1 FROM @Keep k WHERE k.ProductId = p.ProductId
      );

    SELECT @@ROWCOUNT AS Deleted;
  `);

  return Number(result.recordset && result.recordset[0] && result.recordset[0].Deleted) || 0;
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
  deleteProduct,
  deleteNonActive,
  deleteMissing,
  listProducts,
};
