const express = require("express");
const router = express.Router();

const { poolPromise } = require("../config/database");
const { normalizePlatform } = require("../utils/platform");
const { publicError } = require("../utils/normalize");
const syncEngine = require("../services/syncEngine");

router.get("/logs", async (req, res) => {
  try {
    const pool = await poolPromise;

    const result = await pool.request().query(`
      SELECT TOP 100
        Id,
        ConnectionId,
        Platform,
        SyncType AS Action,
        StartTime AS Time,
        EndTime,
        Status,
        Message,
        ErrorMessage,
        OrderCount,
        ProductCount
      FROM SyncLog
      ORDER BY StartTime DESC
    `);

    res.json(result.recordset);
  } catch (error) {
    console.error(error);

    res.status(500).json({
      message: "ไม่สามารถดึง Sync Log ได้",
    });
  }
});

router.post("/:platform", async (req, res) => {
  const platform = normalizePlatform(req.params.platform);

  try {
    const result = await syncEngine.syncPlatform(platform);
    res.json(result);
  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      message: publicError(error, "ซิงก์ไม่สำเร็จ"),
    });
  }
});

module.exports = router;
