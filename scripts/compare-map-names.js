require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const { poolPromise } = require("../config/database");
const sap = require("../services/marketplaces/sapService");
const https = require("https");
const axios = require("axios");

function matchKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[/,|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function sapItems() {
  const baseUrl = String(process.env.SAP_BASE_URL || "")
    .replace(/\/$/, "")
    .replace(/\/b1s\/v1$/i, "");
  const http = axios.create({
    baseURL: `${baseUrl}/b1s/v1`,
    timeout: 30000,
    httpsAgent: new https.Agent({ rejectUnauthorized: false }),
    headers: { "Content-Type": "application/json" },
    validateStatus: () => true,
  });
  const login = await http.post("/Login", {
    CompanyDB: process.env.SAP_COMPANY_DB,
    UserName: process.env.SAP_USERNAME,
    Password: process.env.SAP_PASSWORD,
  });
  const cookie = (login.headers["set-cookie"] || []).join("; ");
  const headers = { Cookie: cookie, Prefer: "odata.maxpagesize=200" };
  const filter = encodeURIComponent(
    "ItemCode eq 'MADAME-0019' or ItemCode eq 'A0001' or ItemCode eq '53217895202' or ItemCode eq 'MADAME-0018'"
  );
  const res = await http.get(
    `/Items?$select=ItemCode,ItemName,ForeignName,InventoryItem,U_Itemcode_api&$filter=${filter}`,
    { headers }
  );
  return res.data.value || [];
}

async function main() {
  const pool = await poolPromise;
  const r = await pool.request().query(`
    SELECT TOP 20 Platform, ProductId, Sku, Name, VariantsJson
    FROM dbo.MarketplaceProduct
    WHERE Name LIKE N'%โฮโลแกรม%' OR Name LIKE N'%BIG BOSS%' OR Name LIKE N'%กุหลาบ%'
    ORDER BY Platform, Name
  `);

  const items = await sapItems();
  console.log("SAP compare targets:");
  for (const i of items) {
    console.log({
      code: i.ItemCode,
      inv: i.InventoryItem,
      foreign: i.ForeignName,
      api: i.U_Itemcode_api,
      name: i.ItemName,
      key: matchKey(i.ItemName),
      len: String(i.ItemName || "").length,
    });
  }

  for (const row of r.recordset) {
    let variants = [];
    try {
      variants = row.VariantsJson ? JSON.parse(row.VariantsJson) : [];
    } catch {
      variants = [];
    }
    console.log("\nPRODUCT", row.Platform, row.ProductId);
    console.log("name:", row.Name);
    console.log("key:", matchKey(row.Name), "len", String(row.Name || "").length);
    console.log(
      "variants:",
      variants.slice(0, 3).map((v) => ({ sku: v.sku, option: v.option }))
    );

    const mapped = await sap.mapProduct({
      platform: row.Platform,
      productId: row.ProductId,
      sku: row.Sku,
      name: row.Name,
      variants,
    });
    console.log("mapped", {
      sapItemCode: mapped.sapItemCode,
      sample: mapped.variants.slice(0, 3).map((v) => ({
        sku: v.sku,
        sap: v.sapItemCode,
        problem: v.problem,
      })),
    });

    for (const i of items) {
      const same = matchKey(row.Name) === matchKey(i.ItemName);
      const starts =
        matchKey(row.Name).startsWith(matchKey(i.ItemName)) ||
        matchKey(i.ItemName).startsWith(matchKey(row.Name));
      console.log("vs", i.ItemCode, { same, starts });
    }
  }

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
