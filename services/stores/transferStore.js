const { poolPromise, sql } = require("../../config/database");
const { ensureSchema } = require("./schema");
const { currentCompanyId } = require("./companyContext");

function text(value) {
  return String(value == null ? "" : value).trim();
}

async function companyOf(companyId) {
  return companyId ? String(companyId) : currentCompanyId();
}

async function findBlocking(companyId, salesOrderIds) {
  const ids = [...new Set(salesOrderIds.map(text).filter(Boolean))];
  if (!ids.length) return [];
  await ensureSchema();
  const pool = await poolPromise;
  const request = pool.request().input("companyId", sql.NVarChar(100), await companyOf(companyId));
  const names = ids.map((id, index) => {
    request.input(`id${index}`, sql.NVarChar(100), id);
    return `@id${index}`;
  });
  const result = await request.query(`
    SELECT
      l.SalesOrderId,
      t.DocumentNo,
      t.Status,
      t.SapDocNum
    FROM dbo.StockTransferOrder l
    INNER JOIN dbo.StockTransfer t ON t.Id = l.TransferId
    WHERE ISNULL(t.CompanyId, N'') = ISNULL(@companyId, N'')
      AND t.Status IN (N'pending', N'success')
      AND l.SalesOrderId IN (${names.join(", ")})
  `);
  return result.recordset;
}

async function insertTransfer(row) {
  await ensureSchema();
  const pool = await poolPromise;
  const transaction = new sql.Transaction(pool);
  await transaction.begin();
  try {
    const header = transaction.request();
    header.input("companyId", sql.NVarChar(100), row.companyId);
    header.input("documentNo", sql.NVarChar(100), row.documentNo);
    header.input("platform", sql.NVarChar(50), row.platform || null);
    header.input("fromWarehouse", sql.NVarChar(50), row.fromWarehouse);
    header.input("toWarehouse", sql.NVarChar(50), row.toWarehouse);
    header.input("status", sql.NVarChar(20), row.status || "pending");
    header.input("requestedBy", sql.NVarChar(100), row.requestedBy || null);
    header.input("note", sql.NVarChar(254), row.note || null);
    header.input("referenceNo", sql.NVarChar(254), row.referenceNo || null);
    header.input("numAtCard", sql.NVarChar(100), row.numAtCard || null);
    header.input("dueDate", sql.DateTime, row.dueDate || null);
    header.input("errorMessage", sql.NVarChar(500), row.errorMessage || null);
    const inserted = await header.query(`
      INSERT INTO dbo.StockTransfer
      (
        CompanyId, DocumentNo, Platform, FromWarehouse, ToWarehouse, Status,
        RequestedBy, Note, ReferenceNo, NumAtCard, DueDate, ErrorMessage
      )
      OUTPUT INSERTED.Id
      VALUES
      (
        @companyId, @documentNo, @platform, @fromWarehouse, @toWarehouse, @status,
        @requestedBy, @note, @referenceNo, @numAtCard, @dueDate, @errorMessage
      )
    `);
    const transferId = inserted.recordset[0].Id;
    for (const line of row.lines || []) {
      await transaction
        .request()
        .input("transferId", sql.Int, transferId)
        .input("sku", sql.NVarChar(100), line.sku)
        .input("sapItemCode", sql.NVarChar(50), line.sapItemCode || null)
        .input("qty", sql.Decimal(18, 4), line.qty)
        .input("name", sql.NVarChar(255), line.name || null)
        .query(`
          INSERT INTO dbo.StockTransferLine (TransferId, Sku, SapItemCode, Qty, Name)
          VALUES (@transferId, @sku, @sapItemCode, @qty, @name)
        `);
    }
    for (const salesOrderId of row.salesOrderIds || []) {
      await transaction
        .request()
        .input("transferId", sql.Int, transferId)
        .input("salesOrderId", sql.NVarChar(100), salesOrderId)
        .query(`
          INSERT INTO dbo.StockTransferOrder (TransferId, SalesOrderId)
          VALUES (@transferId, @salesOrderId)
        `);
    }
    await transaction.commit();
    return transferId;
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

async function setResult(id, { status, sapDocNum, sapDocEntry, errorMessage }) {
  await ensureSchema();
  const pool = await poolPromise;
  await pool
    .request()
    .input("id", sql.Int, id)
    .input("status", sql.NVarChar(20), status)
    .input("sapDocNum", sql.NVarChar(50), sapDocNum || null)
    .input("sapDocEntry", sql.NVarChar(50), sapDocEntry || null)
    .input("errorMessage", sql.NVarChar(500), errorMessage || null)
    .query(`
      UPDATE dbo.StockTransfer
      SET Status = @status,
          SapDocNum = @sapDocNum,
          SapDocEntry = @sapDocEntry,
          ErrorMessage = @errorMessage,
          UpdatedAt = GETDATE()
      WHERE Id = @id
    `);
}

function shape(header, lines, orders) {
  const salesOrderIds = orders.map((row) => row.SalesOrderId).filter(Boolean);
  const sapDocNum = header.SapDocNum ? String(header.SapDocNum) : "";
  const documentNo = header.DocumentNo || "";
    const docNo = sapDocNum || documentNo;
  return {
    id: docNo,
    docNum: docNo,
    DocNum: sapDocNum,
    transferId: header.Id,
    documentNo,
    status: header.Status || "pending",
    fromWarehouseId: header.FromWarehouse || "",
    toWarehouseId: header.ToWarehouse || "",
    referenceNo: header.ReferenceNo || salesOrderIds.join(", "),
    numAtCard: header.NumAtCard || header.ReferenceNo || "",
    platform: header.Platform || "",
    requestedBy: header.RequestedBy || "",
    createdAt: header.CreatedAt || null,
    docDate: header.CreatedAt || null,
    dueDate: header.DueDate || null,
    note: header.Note || "",
    sapDocNum,
    sapDocEntry: header.SapDocEntry ? String(header.SapDocEntry) : "",
    errorMessage: header.ErrorMessage || "",
    salesOrderIds,
    items: lines.map((line) => ({
      sku: line.Sku,
      qty: Number(line.Qty) || 0,
      name: line.Name || "",
      sapItemCode: line.SapItemCode || "",
    })),
  };
}

async function listTransfers(companyId) {
  await ensureSchema();
  const pool = await poolPromise;
  const company = await companyOf(companyId);
  const headers = await pool.request().input("companyId", sql.NVarChar(100), company).query(`
    SELECT *
    FROM dbo.StockTransfer
    WHERE ISNULL(CompanyId, N'') = ISNULL(@companyId, N'')
    ORDER BY Id DESC
  `);
  if (!headers.recordset.length) return [];
  const ids = headers.recordset.map((row) => Number(row.Id)).filter((id) => Number.isInteger(id));
  if (!ids.length) return [];
  const inList = ids.join(", ");
  const [lines, orders] = await Promise.all([
    pool.request().query(`SELECT * FROM dbo.StockTransferLine WHERE TransferId IN (${inList})`),
    pool.request().query(`SELECT * FROM dbo.StockTransferOrder WHERE TransferId IN (${inList})`),
  ]);
  const lineMap = new Map();
  for (const line of lines.recordset) {
    const list = lineMap.get(line.TransferId) || [];
    list.push(line);
    lineMap.set(line.TransferId, list);
  }
  const orderMap = new Map();
  for (const order of orders.recordset) {
    const list = orderMap.get(order.TransferId) || [];
    list.push(order);
    orderMap.set(order.TransferId, list);
  }
  return headers.recordset.map((row) => shape(row, lineMap.get(row.Id) || [], orderMap.get(row.Id) || []));
}

async function linksForOrders(companyId) {
  await ensureSchema();
  const pool = await poolPromise;
  const result = await pool.request().input("companyId", sql.NVarChar(100), await companyOf(companyId)).query(`
    SELECT l.SalesOrderId, t.Status, t.SapDocNum, t.DocumentNo
    FROM dbo.StockTransferOrder l
    INNER JOIN dbo.StockTransfer t ON t.Id = l.TransferId
    WHERE ISNULL(t.CompanyId, N'') = ISNULL(@companyId, N'')
      AND t.Status IN (N'pending', N'success', N'failed')
  `);
  const map = new Map();
  const rank = { success: 3, pending: 2, failed: 1 };
  for (const row of result.recordset) {
    const key = String(row.SalesOrderId || "");
    const prev = map.get(key);
    if (!prev || (rank[row.Status] || 0) > (rank[prev.status] || 0)) {
      map.set(key, {
        status: row.Status,
        docNum: row.SapDocNum || row.DocumentNo || "",
      });
    }
  }
  return map;
}

async function findOpenDocument(companyId, documentNo) {
  await ensureSchema();
  const pool = await poolPromise;
  const result = await pool
    .request()
    .input("companyId", sql.NVarChar(100), await companyOf(companyId))
    .input("documentNo", sql.NVarChar(100), documentNo)
    .query(`
      SELECT TOP 1 DocumentNo, Status, SapDocNum
      FROM dbo.StockTransfer
      WHERE ISNULL(CompanyId, N'') = ISNULL(@companyId, N'')
        AND DocumentNo = @documentNo
        AND Status IN (N'pending', N'success')
    `);
  return result.recordset[0] || null;
}

async function expandOrderKeys(tokens) {
  const raw = [...new Set(tokens.map(text).filter(Boolean))];
  const keys = new Set();
  for (const id of raw) {
    keys.add(id);
    const bare = id.replace(/^SO-/i, "");
    if (!bare) continue;
    keys.add(bare);
    keys.add(`SO-${bare}`);
  }
  if (!raw.length) return [];
  await ensureSchema();
  const pool = await poolPromise;
  const request = pool.request().input("companyId", sql.NVarChar(100), await companyOf());
  raw.forEach((id, index) => request.input(`id${index}`, sql.NVarChar(100), id));
  const stripped = [...new Set(raw.map((id) => id.replace(/^SO-/i, "")))];
  stripped.forEach((id, index) => request.input(`sap${index}`, sql.NVarChar(100), id));
  const result = await request.query(`
    SELECT MarketplaceOrderId, SapDocNum
    FROM dbo.MarketplaceOrder
    WHERE ISNULL(CompanyId, N'') = ISNULL(@companyId, N'')
      AND (
        MarketplaceOrderId IN (${raw.map((_, index) => `@id${index}`).join(", ")})
        OR SapDocNum IN (${stripped.map((_, index) => `@sap${index}`).join(", ")})
      )
  `);
  for (const row of result.recordset) {
    if (row.MarketplaceOrderId) keys.add(String(row.MarketplaceOrderId));
    if (row.SapDocNum) {
      keys.add(String(row.SapDocNum));
      keys.add(`SO-${row.SapDocNum}`);
    }
  }
  return [...keys];
}

module.exports = {
  findBlocking,
  findOpenDocument,
  expandOrderKeys,
  insertTransfer,
  setResult,
  listTransfers,
  linksForOrders,
};
