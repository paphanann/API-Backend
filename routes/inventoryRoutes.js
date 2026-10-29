const express = require("express");
const router = express.Router();

const inventoryStore = require("../services/stores/inventoryStore");
const connectionStore = require("../services/stores/connectionStore");

const ALLOWED_WAREHOUSES = new Set(["01", "C01-RT", "C02-PR9", "C03-HOLD", "C04-CM"]);

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

async function saveWarehouseMap(req, res) {
  try {
    const body = req.body || {};
    const warehouseCode = String(body.sapWhsCode || body.warehouseCode || body.WhsCode || "").trim();
    const platform = String(body.platform || "").trim();
    const shopId = String(body.shopId || body.warehouseId || "").trim();
    if (!platform || !shopId) {
      return res.status(400).json({ message: "ต้องระบุแพลตฟอร์มและร้าน" });
    }
    if (!ALLOWED_WAREHOUSES.has(warehouseCode)) {
      return res.status(400).json({
        message: "คลังที่ใช้ได้คือ 01, C01-RT, C02-PR9, C03-HOLD, C04-CM",
      });
    }
    const updated = await connectionStore.setShopWarehouse({ platform, shopId, warehouseCode });
    if (!updated) {
      return res.status(404).json({ message: "ไม่พบร้านนี้" });
    }
    res.json({
      platform,
      shopId,
      sapWhsCode: warehouseCode,
      Warehouse: warehouseCode,
      warehouse: warehouseCode,
      WhsCode: warehouseCode,
      warehouseCode,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "บันทึกคลังของร้านไม่สำเร็จ" });
  }
}

router.put("/mapping", saveWarehouseMap);
router.put("/map", saveWarehouseMap);

module.exports = router;
