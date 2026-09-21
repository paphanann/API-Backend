const https = require("https");
const express = require("express");
const axios = require("axios");

const settingsStore = require("../services/stores/settingsStore");
const { publicError } = require("../utils/normalize");

const router = express.Router();

router.get("/", async (req, res) => {
  try {
    const settings = await settingsStore.getSettings();
    res.json(settings);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: publicError(error, "ไม่สามารถดึงการตั้งค่าได้") });
  }
});

router.put("/", async (req, res) => {
  try {
    const settings = await settingsStore.saveSettings(req.body || {});
    res.json({ success: true, message: "บันทึกการตั้งค่าแล้ว", ...settings });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: publicError(error, "ไม่สามารถบันทึกการตั้งค่าได้") });
  }
});

router.post("/", async (req, res) => {
  try {
    const settings = await settingsStore.saveSettings(req.body || {});
    res.json({ success: true, message: "บันทึกการตั้งค่าแล้ว", ...settings });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: publicError(error, "ไม่สามารถบันทึกการตั้งค่าได้") });
  }
});

router.post("/test-erp", async (req, res) => {
  try {
    const body = req.body || {};
    const creds = await settingsStore.getErpCredentials(body);

    if (!creds.baseUrl || !creds.companyDb || !creds.username || !creds.password) {
      return res.status(400).json({
        success: false,
        message: "กรอก Endpoint, Database, Username และ Password ให้ครบก่อนทดสอบ",
      });
    }

    const insecure = String(process.env.SAP_TLS_INSECURE || "").toLowerCase() === "true";
    const http = axios.create({
      baseURL: `${creds.baseUrl}/b1s/v1`,
      timeout: 20000,
      httpsAgent: insecure ? new https.Agent({ rejectUnauthorized: false }) : undefined,
      headers: { "Content-Type": "application/json" },
      validateStatus: () => true,
    });

    const response = await http.post("/Login", {
      CompanyDB: creds.companyDb,
      UserName: creds.username,
      Password: creds.password,
    });

    if (response.status >= 200 && response.status < 300 && response.data && response.data.SessionId) {
      await settingsStore.markErpChecked();
      // logout best-effort
      try {
        await http.post(
          "/Logout",
          {},
          { headers: { Cookie: `B1SESSION=${response.data.SessionId}` } }
        );
      } catch {
        /* ignore */
      }
      return res.json({
        success: true,
        message: `เชื่อมต่อ SAP สำเร็จ (${creds.companyDb})`,
      });
    }

    const detail =
      (response.data && (response.data.error?.message?.value || response.data.message)) ||
      `HTTP ${response.status}`;
    return res.status(400).json({
      success: false,
      message: `เชื่อมต่อ SAP ไม่สำเร็จ: ${detail}`,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      message: publicError(error, "ทดสอบ ERP ไม่สำเร็จ"),
    });
  }
});

router.get("/users", async (req, res) => {
  try {
    const users = await settingsStore.listUsers();
    res.json(users);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: publicError(error, "ไม่สามารถดึงผู้ใช้งานได้") });
  }
});

router.post("/users", async (req, res) => {
  try {
    const user = await settingsStore.createUser(req.body || {});
    res.status(201).json(user);
  } catch (error) {
    const status = error.statusCode || 500;
    if (status >= 500) console.error(error);
    res.status(status).json({ message: publicError(error, "ไม่สามารถบันทึกผู้ใช้งานได้") });
  }
});

router.put("/users/:id", async (req, res) => {
  try {
    const user = await settingsStore.updateUser(req.params.id, req.body || {});
    res.json(user);
  } catch (error) {
    const status = error.statusCode || 500;
    if (status >= 500) console.error(error);
    res.status(status).json({ message: publicError(error, "ไม่สามารถบันทึกผู้ใช้งานได้") });
  }
});

router.delete("/users/:id", async (req, res) => {
  try {
    await settingsStore.deleteUser(req.params.id);
    res.json({ success: true, message: "ลบผู้ใช้งานแล้ว" });
  } catch (error) {
    const status = error.statusCode || 500;
    if (status >= 500) console.error(error);
    res.status(status).json({ message: publicError(error, "ไม่สามารถลบผู้ใช้งานได้") });
  }
});

module.exports = router;
