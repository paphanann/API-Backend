const crypto = require("crypto");
const express = require("express");
const bcrypt = require("bcryptjs");

const { poolPromise, sql } = require("../config/database");

const router = express.Router();

const INVALID = {
  message: "อีเมลหรือรหัสผ่านไม่ถูกต้อง",
};

function pick(row, names) {
  if (!row) return "";
  for (const name of names) {
    if (row[name] !== undefined && row[name] !== null && String(row[name]).trim() !== "") {
      return String(row[name]).trim();
    }
  }
  return "";
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

async function passwordMatches(plain, stored) {
  if (!plain || stored === undefined || stored === null) return false;

  const hash = String(stored).trim();

  if (hash.startsWith("$2a$") || hash.startsWith("$2b$") || hash.startsWith("$2y$")) {
    return bcrypt.compare(plain, hash);
  }

  const sha256 = crypto.createHash("sha256").update(plain, "utf8").digest("hex");
  if (safeEqual(sha256.toLowerCase(), hash.toLowerCase())) return true;

  return safeEqual(plain, hash);
}

function isActive(row) {
  const value = pick(row, ["IsActive", "Active", "Status"]);
  if (!value) return true;
  const normalized = value.toUpperCase();
  return normalized === "Y" || normalized === "1" || normalized === "TRUE" || normalized === "ACTIVE";
}

async function tableExists(pool, tableName) {
  const result = await pool
    .request()
    .input("tableName", sql.NVarChar, tableName)
    .query(`
      SELECT 1 AS ok
      FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA = N'dbo'
        AND TABLE_NAME = @tableName
    `);

  return result.recordset.length > 0;
}

async function findLoginUser(pool, login) {
  if (await tableExists(pool, "Users")) {
    const result = await pool
      .request()
      .input("login", sql.NVarChar, login)
      .query(`
        SELECT TOP 1
          Username,
          Password,
          FullName,
          IsActive
        FROM dbo.Users
        WHERE Username = @login
      `);

    if (result.recordset[0]) {
      return result.recordset[0];
    }
  }

  if (await tableExists(pool, "AppUser")) {
    const result = await pool
      .request()
      .input("login", sql.NVarChar, login)
      .query(`
        SELECT TOP 1
          Email,
          Username,
          Name,
          PasswordHash
        FROM dbo.AppUser
        WHERE Email = @login
           OR Username = @login
      `);

    if (result.recordset[0]) {
      return result.recordset[0];
    }
  }

  return null;
}

router.post("/login", async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim();
    const username = String(req.body?.username || "").trim();
    const password = String(req.body?.password || "");
    const login = email || username;

    if (!login || !password) {
      return res.status(401).json(INVALID);
    }

    const pool = await poolPromise;
    const row = await findLoginUser(pool, login);
    const storedPassword = pick(row, ["Password", "PasswordHash"]);

    if (!row || !isActive(row) || !(await passwordMatches(password, storedPassword))) {
      return res.status(401).json(INVALID);
    }

    res.json({
      token: "",
      user: {
        email: pick(row, ["Email", "Username"]) || login,
        name: pick(row, ["FullName", "Name"]) || login,
      },
    });
  } catch (error) {
    console.error("Login failed:", error.message);

    res.status(500).json({
      message: "เชื่อมต่อฐานข้อมูลไม่ได้ กรุณาตรวจสอบการเชื่อมต่อ SQL Server",
    });
  }
});

module.exports = router;
