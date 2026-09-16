const express = require("express");
const router = express.Router();

const { normalizePlatform } = require("../utils/platform");
const productStore = require("../services/productStore");

router.get("/", async (req, res) => {
  try {
    const platform = normalizePlatform(req.query.platform);
    const rows = await productStore.listProducts(platform);
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({
      message: "ไม่สามารถดึงสินค้าได้",
    });
  }
});

module.exports = router;
