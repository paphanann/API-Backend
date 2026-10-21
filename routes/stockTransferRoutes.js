const express = require("express");

const sapService = require("../services/marketplaces/sapService");
const { publicError } = require("../utils/normalize");

const router = express.Router();

function text(value) {
  return String(value == null ? "" : value).replace(/\|/g, " ").replace(/\s+/g, " ").trim();
}

function sapDay(value) {
  const raw = String(value || "").trim();
  const match = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  if (match) return match[1];
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function packComment({ platform, requestedBy, documentNo, note }) {
  return ["PASS", text(platform), text(requestedBy), text(documentNo), text(note)].join("|").slice(0, 254);
}

function unpackComment(comments) {
  const raw = String(comments || "");
  if (!raw.startsWith("PASS|")) {
    return { platform: "", requestedBy: "", referenceNo: "", note: raw };
  }
  const parts = raw.split("|");
  return {
    platform: parts[1] || "",
    requestedBy: parts[2] || "",
    referenceNo: parts[3] || "",
    note: parts.slice(4).join("|"),
  };
}

function mapStatus(row) {
  if (String(row.Cancelled || "").toUpperCase() === "TYES") return "failed";
  return "success";
}

function mapTransfer(row) {
  const meta = unpackComment(row.Comments);
  const lines = Array.isArray(row.StockTransferLines) ? row.StockTransferLines : [];
  const docNum = row.DocNum == null ? "" : String(row.DocNum);
  return {
    id: docNum || String(row.DocEntry || ""),
    DocNum: docNum,
    fromWarehouseId: row.FromWarehouse || "",
    toWarehouseId: row.ToWarehouse || "",
    items: lines
      .filter((line) => line && line.ItemCode)
      .map((line) => ({
        sku: String(line.ItemCode),
        name: String(line.ItemDescription || ""),
        qty: Number(line.Quantity) || 0,
      })),
    note: meta.note,
    status: mapStatus(row),
    createdAt: row.DocDate || null,
    dueDate: row.DueDate || row.DocDate || null,
    referenceNo: meta.referenceNo,
    requestedBy: meta.requestedBy,
    platform: meta.platform,
  };
}

function readLines(body) {
  const source = body.items || body.lines || body.StockTransferLines || [];
  return (Array.isArray(source) ? source : [])
    .map((line) => ({
      sku: text(line.sku || line.ItemCode || line.itemCode),
      qty: Number(line.qty || line.Quantity || line.quantity),
    }))
    .filter((line) => line.sku && Number.isFinite(line.qty) && line.qty > 0);
}

router.get("/", async (req, res) => {
  try {
    const rows = await sapService.listInventoryTransferRequests();
    res.json(rows.map(mapTransfer));
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: publicError(error, "ดึงใบขอโอนจาก SAP ไม่สำเร็จ") });
  }
});

router.post("/", async (req, res) => {
  try {
    const body = req.body || {};
    const fromWarehouse = text(body.fromWarehouseId || body.FromWarehouse || body.fromWhs);
    const toWarehouse = text(body.toWarehouseId || body.ToWarehouse || body.toWhs);
    const lines = readLines(body);
    const docDate = sapDay(body.dueDate || body.docDate || body.DocDate);

    if (!fromWarehouse || !toWarehouse) {
      return res.status(400).json({ message: "เลือกคลังต้นทางและคลังปลายทาง" });
    }
    if (fromWarehouse === toWarehouse) {
      return res.status(400).json({ message: "คลังต้นทางและคลังปลายทางต้องไม่ใช่คลังเดียวกัน" });
    }
    if (!lines.length) {
      return res.status(400).json({ message: "เลือกสินค้าและระบุจำนวนโอน" });
    }

    const created = await sapService.createInventoryTransferRequest({
      DocDate: docDate,
      DueDate: docDate,
      FromWarehouse: fromWarehouse,
      ToWarehouse: toWarehouse,
      Comments: packComment({
        platform: body.platform,
        requestedBy: body.requestedBy,
        documentNo: body.documentNo || body.referenceNo,
        note: body.note || body.comments || body.reason,
      }),
      StockTransferLines: lines.map((line) => ({
        ItemCode: line.sku,
        Quantity: line.qty,
        FromWarehouseCode: fromWarehouse,
        WarehouseCode: toWarehouse,
      })),
    });

    res.status(201).json(mapTransfer(created || {}));
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: publicError(error, "บันทึกใบขอโอนเข้า SAP ไม่สำเร็จ") });
  }
});

module.exports = router;
