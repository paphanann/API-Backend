require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const https = require("https");
const axios = require("axios");

async function main() {
  const baseUrl = String(process.env.SAP_BASE_URL || "")
    .replace(/\/$/, "")
    .replace(/\/b1s\/v1$/i, "");
  const insecure = String(process.env.SAP_TLS_INSECURE || "").toLowerCase() === "true";
  const http = axios.create({
    baseURL: `${baseUrl}/b1s/v1`,
    timeout: 30000,
    httpsAgent: insecure ? new https.Agent({ rejectUnauthorized: false }) : undefined,
    headers: { "Content-Type": "application/json" },
    validateStatus: () => true,
  });

  const login = await http.post("/Login", {
    CompanyDB: process.env.SAP_COMPANY_DB,
    UserName: process.env.SAP_USERNAME,
    Password: process.env.SAP_PASSWORD,
  });
  console.log("login", login.status, Boolean(login.data && login.data.SessionId));
  if (login.status >= 400) {
    console.log(login.data);
    process.exit(1);
  }

  const cookie = (login.headers["set-cookie"] || []).join("; ");
  const headers = {
    Cookie: cookie || `B1SESSION=${login.data.SessionId}`,
    Prefer: "odata.maxpagesize=100",
  };

  // try with UDF first
  let path =
    "/Items?$select=ItemCode,ItemName,ForeignName,InventoryItem,U_Itemcode_api&$orderby=ItemCode";
  let res = await http.get(path, { headers });
  if (res.status >= 400) {
    console.log("select with U_Itemcode_api failed", res.status, JSON.stringify(res.data).slice(0, 400));
    path = "/Items?$select=ItemCode,ItemName,ForeignName,InventoryItem&$orderby=ItemCode";
    res = await http.get(path, { headers });
    console.log("fallback select", res.status);
  }

  const items = [];
  while (res.status < 400 && items.length < 5000) {
    items.push(...((res.data && res.data.value) || []));
    const next = res.data && (res.data["odata.nextLink"] || res.data["@odata.nextLink"]);
    if (!next) break;
    path = String(next).replace(/^https?:\/\/[^/]+\/b1s\/v\d+/i, "");
    res = await http.get(path, { headers });
  }

  console.log("items", items.length);
  const withApi = items.filter((i) => i.U_Itemcode_api);
  console.log("with U_Itemcode_api", withApi.length);
  console.log(
    "sample api",
    withApi.slice(0, 15).map((i) => ({
      c: i.ItemCode,
      api: i.U_Itemcode_api,
      n: String(i.ItemName || "").slice(0, 30),
    }))
  );

  const a = items.filter(
    (i) =>
      String(i.U_Itemcode_api || "") === "A0001" ||
      String(i.ItemCode || "") === "A0001" ||
      String(i.ItemName || "").includes("โฮโลแกรม") ||
      String(i.ItemName || "").includes("BIG BOSS")
  );
  console.log(
    "search hits",
    a.map((i) => ({
      c: i.ItemCode,
      api: i.U_Itemcode_api,
      n: String(i.ItemName || "").slice(0, 50),
      inv: i.InventoryItem,
      f: i.ForeignName,
    }))
  );

  if (items[0]) console.log("keys", Object.keys(items[0]));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
