const express = require("express");
const router = express.Router();

const { normalizePlatform } = require("../utils/platform");
const orderStore = require("../services/stores/orderStore");

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
    const rows = await orderStore.listOrders(platform);
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({
      message: "ไม่สามารถดึง Order ได้",
    });
  }
});

module.exports = router;
