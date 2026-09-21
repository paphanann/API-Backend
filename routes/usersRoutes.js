const express = require("express");
const settingsStore = require("../services/stores/settingsStore");
const { publicError } = require("../utils/normalize");

const router = express.Router();

function fail(res, error, fallback) {
  const status = error.statusCode || 500;
  if (status >= 500) console.error(error);
  res.status(status).json({ message: publicError(error, fallback) });
}

router.get("/", async (req, res) => {
  try {
    const users = await settingsStore.listUsers();
    res.json(users);
  } catch (error) {
    fail(res, error, "ไม่สามารถดึงผู้ใช้งานได้");
  }
});

router.post("/", async (req, res) => {
  try {
    const user = await settingsStore.createUser(req.body || {});
    res.status(201).json(user);
  } catch (error) {
    fail(res, error, "ไม่สามารถบันทึกผู้ใช้งานได้");
  }
});

router.put("/:id", async (req, res) => {
  try {
    const user = await settingsStore.updateUser(req.params.id, req.body || {});
    res.json(user);
  } catch (error) {
    fail(res, error, "ไม่สามารถบันทึกผู้ใช้งานได้");
  }
});

router.delete("/:id", async (req, res) => {
  try {
    await settingsStore.deleteUser(req.params.id);
    res.json({ success: true, message: "ลบผู้ใช้งานแล้ว" });
  } catch (error) {
    fail(res, error, "ไม่สามารถลบผู้ใช้งานได้");
  }
});

module.exports = router;
