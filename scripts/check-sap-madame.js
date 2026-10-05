require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const https = require("https");
const axios = require("axios");

async function main() {
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
    "startswith(ItemCode,'MADAME') or startswith(ItemCode,'A000') or ItemCode eq '53217895202' or startswith(ItemCode,'162636')"
  );
  const res = await http.get(
    `/Items?$select=ItemCode,ItemName,ForeignName,InventoryItem,U_Itemcode_api&$filter=${filter}&$orderby=ItemCode`,
    { headers }
  );
  console.log("status", res.status, "count", (res.data.value || []).length);
  for (const i of res.data.value || []) {
    console.log(
      [i.ItemCode, i.InventoryItem, i.ForeignName || "-", i.U_Itemcode_api || "-", String(i.ItemName || "").slice(0, 55)].join(
        " | "
      )
    );
  }

  // simulate filter in listMasterItems
  const kept = (res.data.value || []).filter((row) => {
    const foreign = String(row.ForeignName || "").toLowerCase();
    if (["shopee", "tiktok", "lazada"].includes(foreign) && row.InventoryItem === "tNO") return false;
    return true;
  });
  console.log("\nafter PLATFORM_FOREIGN filter kept:", kept.length);
  for (const i of kept) {
    console.log([i.ItemCode, i.InventoryItem, i.ForeignName || "-", i.U_Itemcode_api || "-"].join(" | "));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
