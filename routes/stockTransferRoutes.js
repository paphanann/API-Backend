const express = require("express");

const sapService = require("../services/marketplaces/sapService");
const transferStore = require("../services/stores/transferStore");
const syncLogStore = require("../services/stores/syncLogStore");
const { currentCompanyId } = require("../services/stores/companyContext");
const { normalizePlatform } = require("../utils/platform");
const { publicError } = require("../utils/normalize");

const router = express.Router();

const ALLOWED_WAREHOUSES = new Set(["01", "MDL", "ONLINE", "C01-RT", "C02-PR9", "C03-HOLD", "C04-CM"]);

function text(value, max) {
  const clean = String(value == null ? "" : value).replace(/\s+/g, " ").trim();
  return max ? clean.slice(0, max) : clean;
}

function sapDay(value) {
  const raw = String(value || "").trim();
  const match = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  if (match) return match[1];
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function dueDate(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function splitRefs(...values) {
  const keys = [];
  for (const value of values) {
    if (Array.isArray(value)) {
      for (const item of value) keys.push(text(item));
      continue;
    }
    for (const part of String(value || "").split(/[,;]+/)) keys.push(text(part));
  }
  return [...new Set(keys.filter(Boolean))];
}

function readLines(body) {
  const source = body.items || body.lines || [];
  return (Array.isArray(source) ? source : [])
    .map((line) => ({
      sku: text(line.sku || line.ItemCode || line.itemCode, 100),
      qty: Number(line.qty != null ? line.qty : line.Quantity),
      name: text(line.name || line.itemName || line.ItemName, 255),
    }))
    .filter((line) => line.sku && Number.isFinite(line.qty) && line.qty > 0);
}

function isDelay(error) {
  const message = String((error && error.message) || "").toLowerCase();
  return (
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("econnreset") ||
    message.includes("econnaborted") ||
    message.includes("socket hang up")
  );
}

async function logFailure(platform, salesOrderIds, message) {
  try {
    await syncLogStore.writeLog({
      platform: platform || "SAP",
      syncType: "stock-transfer",
      status: "error",
      message,
      errorMessage: message,
      marketplaceOrderId: salesOrderIds[0] || null,
    });
  } catch (error) {
    console.error(error);
  }
}

async function savedView(documentNo) {
  const rows = await transferStore.listTransfers();
  return rows.find((row) => row.documentNo === documentNo) || null;
}

async function reconcilePending(rows) {
  const pending = rows.filter((row) => row.status === "pending").slice(0, 5);
  if (!pending.length || !sapService.isConfigured()) return rows;
  let changed = false;
  await Promise.race([
    Promise.all(
      pending.map(async (row) => {
        try {
          const found = await sapService.findStockTransfer(row.documentNo, row.numAtCard);
          if (!found || found.DocNum == null) return;
          await transferStore.setResult(row.transferId, {
            status: "success",
            sapDocNum: String(found.DocNum),
            sapDocEntry: found.DocEntry == null ? "" : String(found.DocEntry),
            errorMessage: "",
          });
          changed = true;
        } catch (error) {
          console.error(error);
        }
      })
    ),
    new Promise((resolve) => setTimeout(resolve, 4000)),
  ]);
  return changed ? transferStore.listTransfers() : rows;
}

router.get("/", async (req, res) => {
  try {
    const rows = await reconcilePending(await transferStore.listTransfers());
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: publicError(error, "ดึงประวัติใบโอนไม่สำเร็จ") });
  }
});

router.post("/", async (req, res) => {
  try {
    const body = req.body || {};
    const fromWarehouse = text(body.fromWarehouseId || body.FromWarehouse, 50);
    const toWarehouse = text(body.toWarehouseId || body.ToWarehouse, 50);
    const documentNo = text(body.documentNo, 100);
    const platformRaw = text(body.platform, 50).toLowerCase();
    const platform = normalizePlatform(platformRaw);
    const requestedBy = text(body.requestedBy, 100);
    const note = text(body.note || body.comments, 254);
    const referenceNo = text(body.referenceNo, 254);
    const numAtCard = text(body.numAtCard || body.referenceNo, 100);
    const lines = readLines(body);
    const docDate = sapDay(body.dueDate || body.docDate);
    const companyId = await currentCompanyId();

    if (!documentNo) {
      return res.status(400).json({ message: "ต้องมีเลขที่เอกสาร documentNo" });
    }
    if (!["Shopee", "TikTok", "Lazada"].includes(platform)) {
      return res.status(400).json({ message: "แพลตฟอร์มต้องเป็น shopee, tiktok หรือ lazada" });
    }
    if (!fromWarehouse || !toWarehouse) {
      return res.status(400).json({ message: "ต้องมีคลังต้นทางและคลังปลายทาง" });
    }
    if (!ALLOWED_WAREHOUSES.has(fromWarehouse) || !ALLOWED_WAREHOUSES.has(toWarehouse)) {
      return res.status(400).json({
        message: "คลังที่ใช้ได้คือ 01, MDL, ONLINE, C01-RT, C02-PR9, C03-HOLD, C04-CM",
      });
    }
    if (fromWarehouse === toWarehouse) {
      return res.status(400).json({ message: "คลังต้นทางและคลังปลายทางต้องไม่ใช่คลังเดียวกัน" });
    }
    if (!lines.length) {
      return res.status(400).json({ message: "ต้องมีรายการสินค้าอย่างน้อย 1 รายการ" });
    }

    const openDoc = await transferStore.findOpenDocument(companyId, documentNo);
    if (openDoc) {
      return res.status(409).json({
        message: `เลขที่ ${documentNo} มีสถานะ ${openDoc.Status} อยู่แล้ว`,
      });
    }

    const salesOrderIds = await transferStore.expandOrderKeys(
      splitRefs(body.salesOrderIds, body.referenceNo, body.numAtCard)
    );
    const blocking = await transferStore.findBlocking(companyId, salesOrderIds);
    if (blocking.length) {
      const detail = blocking
        .map((row) => `${row.SalesOrderId} อยู่บนใบ ${row.DocumentNo} (${row.Status}${row.SapDocNum ? ` ${row.SapDocNum}` : ""})`)
        .join(", ");
      return res.status(409).json({
        message: `ออเดอร์นี้ผูกกับใบโอนที่ค้างหรือสำเร็จแล้ว: ${detail}`,
      });
    }

    const storedLines = lines.map((line) => ({
      sku: line.sku,
      qty: line.qty,
      name: line.name,
      sapItemCode: "",
    }));

    async function keepFailed(message) {
      await transferStore.insertTransfer({
        companyId,
        documentNo,
        platform: platformRaw,
        fromWarehouse,
        toWarehouse,
        status: "failed",
        requestedBy,
        note,
        referenceNo,
        numAtCard,
        dueDate: dueDate(body.dueDate),
        errorMessage: text(message, 500),
        lines: storedLines,
        salesOrderIds,
      });
      await logFailure(platform, salesOrderIds, message);
      const view = await savedView(documentNo);
      return res.status(201).json(view || { documentNo, status: "failed", message });
    }

    let mapped;
    try {
      mapped = await sapService.mapTransferSkus(platform, lines);
    } catch (error) {
      return keepFailed(publicError(error, "แมปสินค้าไม่สำเร็จ"));
    }
    if (mapped.errors.length) {
      return keepFailed(mapped.errors.join("; "));
    }
    for (const line of mapped.mapped) {
      const slot = storedLines.find((item) => item.sku === line.sku && !item.sapItemCode);
      if (slot) slot.sapItemCode = line.sapItemCode;
    }
    if (storedLines.some((line) => !line.sapItemCode)) {
      return keepFailed("แมปรหัสสินค้าไม่ครบทั้งใบ");
    }

    const needed = new Map();
    for (const line of storedLines) {
      needed.set(line.sapItemCode, (needed.get(line.sapItemCode) || 0) + line.qty);
    }
    const shortages = [];
    try {
      for (const [itemCode, qty] of needed) {
        const available = await sapService.warehouseStock(itemCode, fromWarehouse);
        if (available < qty) {
          shortages.push(`${itemCode} คงเหลือ ${available} ต้องการ ${qty}`);
        }
      }
    } catch (error) {
      return keepFailed(publicError(error, "ตรวจสต็อกคลังต้นทางไม่สำเร็จ"));
    }
    if (shortages.length) {
      return keepFailed(`สต็อกคลัง ${fromWarehouse} ไม่พอ: ${shortages.join("; ")}`);
    }

    const transferId = await transferStore.insertTransfer({
      companyId,
      documentNo,
      platform: platformRaw,
      fromWarehouse,
      toWarehouse,
      status: "pending",
      requestedBy,
      note,
      referenceNo,
      numAtCard,
      dueDate: dueDate(body.dueDate),
      lines: storedLines,
      salesOrderIds,
    });

    const sapDoc = {
      DocDate: docDate,
      DueDate: docDate,
      FromWarehouse: fromWarehouse,
      ToWarehouse: toWarehouse,
      Comments: text(`${documentNo} | ${note}`, 254),
      NumAtCard: numAtCard,
      StockTransferLines: storedLines.map((line) => ({
        ItemCode: line.sapItemCode,
        Quantity: line.qty,
        FromWarehouseCode: fromWarehouse,
        WarehouseCode: toWarehouse,
      })),
    };

    try {
      let created;
      try {
        created = await sapService.createStockTransfer(sapDoc);
      } catch (error) {
        if (!/NumAtCard/i.test(String(error && error.message))) throw error;
        const { NumAtCard, ...withoutCard } = sapDoc;
        created = await sapService.createStockTransfer(withoutCard);
      }
      await transferStore.setResult(transferId, {
        status: "success",
        sapDocNum: created && created.DocNum != null ? String(created.DocNum) : "",
        sapDocEntry: created && created.DocEntry != null ? String(created.DocEntry) : "",
        errorMessage: "",
      });
    } catch (error) {
      const message = publicError(error, "สร้าง Stock Transfer ใน SAP ไม่สำเร็จ");
      if (isDelay(error)) {
        await transferStore.setResult(transferId, {
          status: "pending",
          errorMessage: text(message, 500),
        });
      } else {
        await transferStore.setResult(transferId, {
          status: "failed",
          errorMessage: text(message, 500),
        });
        await logFailure(platform, salesOrderIds, message);
      }
    }

    const view = await savedView(documentNo);
    res.status(201).json(view || { documentNo, status: "pending" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: publicError(error, "บันทึกใบโอนไม่สำเร็จ") });
  }
});

module.exports = router;
