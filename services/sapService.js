const https = require("https");
const axios = require("axios");

const { text } = require("../utils/normalize");

function getConfig() {
  return {
    baseUrl: String(process.env.SAP_BASE_URL || "").replace(/\/$/, ""),
    companyDb: process.env.SAP_COMPANY_DB,
    username: process.env.SAP_USERNAME,
    password: process.env.SAP_PASSWORD,
    cardCode: process.env.SAP_CARD_CODE,
  };
}

function isConfigured() {
  const { baseUrl, companyDb, username, password, cardCode } = getConfig();
  return Boolean(baseUrl && companyDb && username && password && cardCode);
}

function client() {
  const { baseUrl } = getConfig();
  const insecure = String(process.env.SAP_TLS_INSECURE || "").toLowerCase() === "true";

  return axios.create({
    baseURL: `${baseUrl}/b1s/v1`,
    timeout: 30000,
    httpsAgent: insecure ? new https.Agent({ rejectUnauthorized: false }) : undefined,
    headers: { "Content-Type": "application/json" },
  });
}

let session = null;

async function login() {
  const { companyDb, username, password } = getConfig();

  if (!isConfigured()) {
    return null;
  }

  const http = client();
  const response = await http.post("/Login", {
    CompanyDB: companyDb,
    UserName: username,
    Password: password,
  });

  session = {
    sessionId: response.data && response.data.SessionId,
    cookies: response.headers["set-cookie"],
  };

  return session;
}

function sessionHeaders() {
  const headers = { "Content-Type": "application/json" };

  if (session && session.sessionId) {
    headers.Cookie = `B1SESSION=${session.sessionId}`;
  }

  if (session && session.cookies) {
    headers.Cookie = session.cookies.join("; ");
  }

  return headers;
}

async function createSalesOrder(order) {
  if (!isConfigured()) {
    return null;
  }

  if (!session) {
    await login();
  }

  const { cardCode } = getConfig();
  const lines = (order.lines || []).filter((line) => text(line.sku));

  if (!lines.length) {
    throw new Error("ออเดอร์ไม่มีสินค้าสำหรับสร้างใน SAP");
  }

  const payload = {
    CardCode: cardCode,
    NumAtCard: String(order.marketplaceOrderId),
    Comments: `${order.platform} ${order.marketplaceOrderId}`,
    DocumentLines: lines.map((line) => ({
      ItemCode: String(line.sku),
      Quantity: Number(line.qty || 1),
      UnitPrice: Number(line.price || 0),
    })),
  };

  const http = client();

  try {
    const { data } = await http.post("/Orders", payload, { headers: sessionHeaders() });
    return String(data.DocNum || data.DocEntry || "");
  } catch (error) {
    const status = error.response && error.response.status;
    if (status === 401 || status === 301) {
      await login();
      const { data } = await http.post("/Orders", payload, { headers: sessionHeaders() });
      return String(data.DocNum || data.DocEntry || "");
    }

    const sapMessage =
      error.response &&
      error.response.data &&
      (error.response.data.error && error.response.data.error.message && error.response.data.error.message.value);

    throw new Error(sapMessage || error.message || "สร้างใบสั่งขายใน SAP ไม่สำเร็จ");
  }
}

module.exports = {
  isConfigured,
  login,
  createSalesOrder,
};
