const express = require("express");
const router = express.Router();

const inventoryStore = require("../services/stores/inventoryStore");

router.get("/", async (req, res) => {
  try {
    const warehouse = req.query.warehouse || req.query.wh || null;
    const rows = await inventoryStore.listInventory(warehouse);
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({
      message: "ไม่สามารถดึงคลังสินค้าได้",
    });
  }
});

module.exports = router;
