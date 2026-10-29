const { poolPromise } = require("../../config/database");
const { clipText } = require("../../utils/normalize");
const { ensureSchema } = require("./schema");
const { currentCompanyId } = require("./companyContext");

function storedClock(value) {
  if (value == null || value === "") return value;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

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

function shopMatch(alias = "") {
  const shop = alias ? `${alias}.ShopId` : "ShopId";
  const company = alias ? `${alias}.CompanyId` : "CompanyId";
  return `ISNULL(${company}, N'') = ISNULL(@companyId, N'') AND ISNULL(${shop}, N'') = ISNULL(@shopId, N'')`;
}

async function upsertProduct(product) {
  await ensureSchema();
  const pool = await poolPromise;

  await pool
    .request()
    .input("platform", product.platform)
    .input("companyId", product.companyId ? String(product.companyId) : await currentCompanyId())
    .input("shopId", product.shopId ? String(product.shopId) : null)
    .input("productId", clipText(product.productId, 100))
    .input("sku", clipText(product.sku, 100))
    .input("name", clipText(product.name, 255))
    .input("price", product.price)
    .input("stock", product.stock)
    .input("status", clipText(product.status, 50))
    .input("imageUrl", product.imageUrl || null)
    .input("variantsJson", variantsJson(product))
    .query(`
      IF EXISTS (
        SELECT 1
        FROM dbo.MarketplaceProduct
        WHERE Platform = @platform
          AND ProductId = @productId
          AND ${shopMatch()}
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
          CompanyId = @companyId,
          ShopId = @shopId,
          SyncedAt = GETDATE()
        WHERE Platform = @platform
          AND ProductId = @productId
          AND ${shopMatch()}
      END
      ELSE
      BEGIN
        INSERT INTO dbo.MarketplaceProduct
        (
          Platform,
          CompanyId,
          ShopId,
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
          @companyId,
          @shopId,
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

async function deleteProduct(platform, productId, shopId) {
  await ensureSchema();
  const pool = await poolPromise;
  await pool
    .request()
    .input("platform", platform)
    .input("companyId", await currentCompanyId())
    .input("shopId", shopId ? String(shopId) : null)
    .input("productId", String(productId))
    .query(`
      DELETE FROM dbo.MarketplaceProduct
      WHERE Platform = @platform
        AND ProductId = @productId
        AND ${shopMatch()}
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
 * @param {string} shopId
 */
async function deleteMissing(platform, keepProductIds, shopId) {
  await ensureSchema();
  const pool = await poolPromise;
  const keep = [...new Set((keepProductIds || []).map((id) => String(id)).filter(Boolean))];

  if (!keep.length) {
    const result = await pool
      .request()
      .input("platform", platform)
      .input("companyId", await currentCompanyId())
      .input("shopId", shopId ? String(shopId) : null)
      .query(`
        DELETE FROM dbo.MarketplaceProduct
        WHERE Platform = @platform
          AND ${shopMatch()};
        SELECT @@ROWCOUNT AS Deleted;
      `);
    return Number(result.recordset && result.recordset[0] && result.recordset[0].Deleted) || 0;
  }

  const tvpValues = keep.map((_, i) => `(@id${i})`).join(",");
  const req = pool.request()
    .input("platform", platform)
    .input("companyId", await currentCompanyId())
    .input("shopId", shopId ? String(shopId) : null);
  keep.forEach((id, i) => req.input(`id${i}`, id));

  const result = await req.query(`
    DECLARE @Keep TABLE (ProductId NVARCHAR(128) PRIMARY KEY);
    INSERT INTO @Keep (ProductId) VALUES ${tvpValues};

    DELETE p
    FROM dbo.MarketplaceProduct p
    WHERE p.Platform = @platform
      AND ${shopMatch("p")}
      AND NOT EXISTS (
        SELECT 1
        FROM @Keep k
        WHERE k.ProductId COLLATE DATABASE_DEFAULT = p.ProductId COLLATE DATABASE_DEFAULT
      );

    SELECT @@ROWCOUNT AS Deleted;
  `);

  return Number(result.recordset && result.recordset[0] && result.recordset[0].Deleted) || 0;
}

async function listProducts(platform, shopId) {
  await ensureSchema();
  const pool = await poolPromise;
  const request = pool.request();

  let query = `
    SELECT
      p.Id,
      p.Platform,
      p.CompanyId,
      p.ShopId,
      p.ProductId,
      p.Sku,
      p.Name,
      p.Price,
      p.Stock,
      p.Status,
      p.ImageUrl,
      p.VariantsJson,
      p.SyncedAt,
      p.SyncedAt AS UpdatedAt
    FROM dbo.MarketplaceProduct p
    INNER JOIN dbo.MarketplaceConnection c
      ON c.Platform = p.Platform
     AND ISNULL(c.CompanyId, N'') = ISNULL(p.CompanyId, N'')
     AND ISNULL(c.ShopId, N'') = ISNULL(p.ShopId, N'')
     AND UPPER(ISNULL(c.ConnectionStatus, N'')) = N'CONNECTED'
  `;

  const companyId = await currentCompanyId();
  request.input("companyId", companyId);
  const filters = ["ISNULL(p.CompanyId, N'') = ISNULL(@companyId, N'')"];
  if (platform) {
    request.input("platform", platform);
    filters.push("p.Platform = @platform");
  }
  if (shopId) {
    request.input("shopId", String(shopId));
    filters.push("ISNULL(p.ShopId, N'') = ISNULL(@shopId, N'')");
  }
  if (filters.length) {
    query += ` WHERE ${filters.join(" AND ")}`;
  }

  query += " ORDER BY p.SyncedAt DESC";
  const result = await request.query(query);
  return result.recordset.map((row) => {
    const variants = parseVariants(row.VariantsJson);
    const { VariantsJson, ...rest } = row;
    return {
      ...rest,
      SyncedAt: storedClock(row.SyncedAt),
      UpdatedAt: storedClock(row.UpdatedAt),
      Variants: variants,
      variants,
    };
  });
}

async function saveVariantMap(platform, productId, variants, shopId) {
  await ensureSchema();
  const pool = await poolPromise;
  await pool
    .request()
    .input("platform", platform)
    .input("companyId", await currentCompanyId())
    .input("shopId", shopId ? String(shopId) : null)
    .input("productId", String(productId))
    .input("variantsJson", JSON.stringify(variants || []))
    .query(`
      UPDATE dbo.MarketplaceProduct
      SET VariantsJson = @variantsJson
      WHERE Platform = @platform
        AND ProductId = @productId
        AND ${shopMatch()}
    `);
}

function sapCodeIndex(products) {
  const map = new Map();
  for (const row of products || []) {
    for (const variant of row.variants || []) {
      const sku = String(variant.sku || "").trim();
      if (!sku || !variant.sapItemCode) continue;
      const code = String(variant.sapItemCode);
      const list = map.get(sku) || [];
      if (!list.includes(code)) list.push(code);
      map.set(sku, list);
    }
  }
  return map;
}

async function sapCodesForSku(platform, sku) {
  const rows = await listProducts(platform);
  const wanted = String(sku || "").trim();
  const codes = new Set();
  for (const row of rows) {
    for (const variant of row.variants || []) {
      if (String(variant.sku || "").trim() !== wanted || !variant.sapItemCode) continue;
      codes.add(String(variant.sapItemCode));
    }
  }
  return [...codes];
}

module.exports = {
  upsertProduct,
  deleteProduct,
  deleteNonActive,
  deleteMissing,
  listProducts,
  saveVariantMap,
  sapCodeIndex,
  sapCodesForSku,
};
