const express = require("express");
const router = express.Router();

const { normalizePlatform } = require("../utils/platform");
const orderStore = require("../services/stores/orderStore");
const { resendSalesOrder } = require("../services/sync/syncEngine");

router.post("/:id/sales-order", async (req, res) => {
  try {
    const rows = await orderStore.listOrders(null, req.params.id);
    if (!rows.length) {
      return res.status(404).json({ message: "ไม่พบออเดอร์" });
    }
    const result = await resendSalesOrder(rows[0]);
    if (result.status === "error") {
      return res.status(409).json({ message: result.message || "ส่ง Sales Order ไม่สำเร็จ" });
    }
    res.json(result);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "ไม่สามารถส่ง Sales Order ได้" });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const rows = await orderStore.listOrders(null, req.params.id);
    if (!rows.length) {
      return res.status(404).json({ message: "ไม่พบออเดอร์" });
    }
    res.json(rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "ไม่สามารถดึง Order ได้" });
  }
});

router.get("/", async (req, res) => {
  try {
    const platform = normalizePlatform(req.query.platform);
    const page = Number(req.query.page);
    const rows = await orderStore.listOrders(platform, null, {
      from: req.query.from,
      to: req.query.to,
      page: Number.isFinite(page) && page > 0 ? page : 0,
      pageSize: req.query.pageSize,
      status: req.query.status,
      sap: req.query.sap,
      q: req.query.q,
      shopId: req.query.shopId,
      tr: req.query.tr,
      wide: req.query.wide === "1" || req.query.wide === "true",
      links: req.query.links === "1" || req.query.links === "true",
    });
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({
      message: "ไม่สามารถดึง Order ได้",
    });
  }
});

module.exports = router;
