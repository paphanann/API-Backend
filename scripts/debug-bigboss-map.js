require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const sap = require("../services/marketplaces/sapService");

function matchKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[/,|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

(async () => {
  sap.clearMasterCache();
  const product =
    "โลโก้ BIG BOSS สีขาวบนพื้นหลังสีดำ ตัวอักษรหนาและเรียบง่าย ใช้สำหรับแบรนด์ท";
  const m = await sap.mapProduct({
    platform: "Lazada",
    productId: "y",
    sku: "16263626321-1787739263551-0",
    name: product,
    variants: [{ sku: "16263626321-1787739263551-0", option: "16263626321-1787739263551-0" }],
  });
  console.log("result", m.sapItemCode, m.variants[0].sapItemCode);

  // peek via list by mapping rose which works
  const rose = await sap.mapProduct({
    platform: "Shopee",
    productId: "z",
    sku: "P0001",
    name: "ดอกไม้สีขาว 5 ดอก สวยงามมาก",
    variants: [{ sku: "P0001", option: "กุหลาบสีขาว" }],
  });
  console.log("rose", rose.sapItemCode);

  // compare keys using known SAP truncation from earlier dump
  const sapName = "โลโก้ BIG BOSS สีขาวบนพื้นหลังสีดำ ตัวอักษรหนาและเรียบง";
  const a = matchKey(product);
  const b = matchKey(sapName);
  console.log({
    same: a === b,
    prodStartsSap: a.startsWith(b),
    sapLen: b.length,
    prodLen: a.length,
    sapTail: b.slice(-10),
    prodAt: a.slice(b.length - 10, b.length + 5),
  });
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
