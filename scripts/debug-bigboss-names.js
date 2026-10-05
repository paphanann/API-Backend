require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const https = require("https");
const axios = require("axios");

function matchKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[/,|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

(async () => {
  const baseUrl = String(process.env.SAP_BASE_URL || "")
    .replace(/\/$/, "")
    .replace(/\/b1s\/v1$/i, "");
  const http = axios.create({
    baseURL: `${baseUrl}/b1s/v1`,
    httpsAgent: new https.Agent({ rejectUnauthorized: false }),
    validateStatus: () => true,
  });
  const login = await http.post("/Login", {
    CompanyDB: process.env.SAP_COMPANY_DB,
    UserName: process.env.SAP_USERNAME,
    Password: process.env.SAP_PASSWORD,
  });
  const headers = { Cookie: (login.headers["set-cookie"] || []).join("; ") };
  const res = await http.get(
    "/Items?$select=ItemCode,ItemName,ForeignName,InventoryItem,U_Itemcode_api&$filter=startswith(ItemCode,'MADAME-0019') or startswith(ItemCode,'162636')",
    { headers }
  );
  const product =
    "โลโก้ BIG BOSS สีขาวบนพื้นหลังสีดำ ตัวอักษรหนาและเรียบง่าย ใช้สำหรับแบรนด์ท";
  const key = matchKey(product);
  for (const i of res.data.value || []) {
    const nk = matchKey(i.ItemName);
    console.log({
      code: i.ItemCode,
      inv: i.InventoryItem,
      name: i.ItemName,
      nameLen: String(i.ItemName || "").length,
      keyLen: nk.length,
      exact: nk === key,
      prodStarts: key.startsWith(nk),
      softOk: key.startsWith(nk) && nk.length >= 20,
    });
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
