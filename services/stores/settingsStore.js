const bcrypt = require("bcryptjs");

const { poolPromise } = require("../../config/database");
const { ensureSchema } = require("./schema");
const { encrypt, decrypt } = require("../../utils/tokenCrypto");

const DEFAULTS = {
  companyName: "",
  companyCode: "",
  taxId: "",
  phone: "",
  address: "",
  email: "",
  currency: "THB - บาทไทย",
  timezone: "Asia/Bangkok (UTC+7)",
  dateFormat: "DD/MM/YYYY",
  numberFormat: "1,234.56",
  erp: "SAP Business One",
  environment: "Sandbox",
  endpoint: String(process.env.SAP_BASE_URL || ""),
  database: String(process.env.SAP_COMPANY_DB || ""),
  username: String(process.env.SAP_USERNAME || ""),
  autoSync: true,
  notifyError: true,
  notifySuccess: false,
  createSalesOrder: true,
  createDelivery: true,
  createReturn: true,
  createCreditMemo: false,
  defaultCardCode: String(process.env.SAP_CARD_CODE || ""),
  defaultWarehouse: "",
  defaultBranch: "",
  defaultTax: "",
  erpLastChecked: null,
};

const SETTING_KEYS = [...Object.keys(DEFAULTS), "logo"];

function pickKnownSettings(raw = {}) {
  const out = {};
  for (const key of SETTING_KEYS) {
    if (raw[key] !== undefined) out[key] = raw[key];
  }
  return out;
}

function httpError(status, message) {
  const err = new Error(message);
  err.statusCode = status;
  return err;
}

function tryEncrypt(plain) {
  if (!plain) return null;
  try {
    return encrypt(plain);
  } catch {
    return null;
  }
}

function tryDecrypt(stored) {
  if (!stored) return null;
  try {
    return decrypt(stored);
  } catch {
    return null;
  }
}

function publicSettings(row) {
  const raw = row && row.SettingsJson ? JSON.parse(row.SettingsJson) : {};
  const merged = pickKnownSettings({ ...DEFAULTS, ...raw });
  return {
    ...merged,
    hasPassword: Boolean(row && row.PasswordEncrypted),
    erpLastChecked: row && row.ErpLastChecked ? row.ErpLastChecked : merged.erpLastChecked,
  };
}

async function ensureSettingsTable() {
  await ensureSchema();
  const pool = await poolPromise;
  await pool.request().query(`
    IF OBJECT_ID(N'dbo.AppSettings', N'U') IS NULL
    BEGIN
      CREATE TABLE dbo.AppSettings
      (
        Id INT NOT NULL CONSTRAINT PK_AppSettings PRIMARY KEY,
        SettingsJson NVARCHAR(MAX) NOT NULL
          CONSTRAINT DF_AppSettings_Json DEFAULT N'{}',
        PasswordEncrypted NVARCHAR(MAX) NULL,
        ErpLastChecked DATETIME2 NULL,
        UpdatedAt DATETIME2 NOT NULL
          CONSTRAINT DF_AppSettings_UpdatedAt DEFAULT GETDATE(),
        CONSTRAINT CK_AppSettings_Singleton CHECK (Id = 1)
      );

      INSERT INTO dbo.AppSettings (Id, SettingsJson)
      VALUES (1, N'{}');
    END
  `);
}

async function getSettings() {
  await ensureSettingsTable();
  const pool = await poolPromise;
  const result = await pool.request().query(`
    SELECT TOP 1 Id, SettingsJson, PasswordEncrypted, ErpLastChecked, UpdatedAt
    FROM dbo.AppSettings
    WHERE Id = 1
  `);
  const row = result.recordset[0];
  if (!row) {
    return publicSettings(null);
  }
  return publicSettings(row);
}

async function saveSettings(payload = {}) {
  await ensureSettingsTable();
  const pool = await poolPromise;

  const current = await pool.request().query(`
    SELECT TOP 1 SettingsJson, PasswordEncrypted, ErpLastChecked
    FROM dbo.AppSettings WHERE Id = 1
  `);
  const prev = current.recordset[0] || {};
  let prevJson = {};
  try {
    prevJson = prev.SettingsJson ? JSON.parse(prev.SettingsJson) : {};
  } catch {
    prevJson = {};
  }

  const next = pickKnownSettings({
    ...DEFAULTS,
    ...prevJson,
    ...payload,
  });

  let passwordEncrypted = prev.PasswordEncrypted || null;
  const incomingPassword = payload.password || payload.Password;
  if (incomingPassword && String(incomingPassword).trim()) {
    const enc = tryEncrypt(String(incomingPassword).trim());
    if (enc) {
      passwordEncrypted = enc;
    }
  }

  const erpLastChecked = payload.erpLastChecked
    ? new Date(payload.erpLastChecked)
    : prev.ErpLastChecked || null;

  await pool
    .request()
    .input("json", JSON.stringify(next))
    .input("passwordEncrypted", passwordEncrypted)
    .input("erpLastChecked", erpLastChecked)
    .query(`
      IF EXISTS (SELECT 1 FROM dbo.AppSettings WHERE Id = 1)
      BEGIN
        UPDATE dbo.AppSettings
        SET SettingsJson = @json,
            PasswordEncrypted = @passwordEncrypted,
            ErpLastChecked = @erpLastChecked,
            UpdatedAt = GETDATE()
        WHERE Id = 1
      END
      ELSE
      BEGIN
        INSERT INTO dbo.AppSettings (Id, SettingsJson, PasswordEncrypted, ErpLastChecked)
        VALUES (1, @json, @passwordEncrypted, @erpLastChecked)
      END
    `);

  return getSettings();
}

async function getErpCredentials(override = {}) {
  const settings = await getSettings();
  const pool = await poolPromise;
  const row = await pool.request().query(`
    SELECT TOP 1 PasswordEncrypted FROM dbo.AppSettings WHERE Id = 1
  `);
  const storedPassword = tryDecrypt(row.recordset[0] && row.recordset[0].PasswordEncrypted);

  return {
    baseUrl: String(override.endpoint || settings.endpoint || process.env.SAP_BASE_URL || "").replace(/\/$/, ""),
    companyDb: String(override.database || settings.database || process.env.SAP_COMPANY_DB || ""),
    username: String(override.username || settings.username || process.env.SAP_USERNAME || ""),
    password: String(
      override.password ||
        storedPassword ||
        process.env.SAP_PASSWORD ||
        ""
    ),
    cardCode: String(override.defaultCardCode || settings.defaultCardCode || process.env.SAP_CARD_CODE || ""),
  };
}

async function markErpChecked() {
  await ensureSettingsTable();
  const pool = await poolPromise;
  await pool.request().query(`
    UPDATE dbo.AppSettings
    SET ErpLastChecked = GETDATE(), UpdatedAt = GETDATE()
    WHERE Id = 1
  `);
}

async function columnSet(pool, tableName) {
  const result = await pool
    .request()
    .input("tableName", tableName)
    .query(`
      SELECT COLUMN_NAME
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = N'dbo' AND TABLE_NAME = @tableName
    `);
  return new Set(result.recordset.map((r) => String(r.COLUMN_NAME)));
}

function mapUserRow(r) {
  return {
    id: r.Id == null ? "" : String(r.Id),
    name: r.Name,
    email: r.Email,
    role: r.Role || "User",
    active: Boolean(r.Active),
  };
}

function userInput(payload = {}) {
  const name = String(payload.name || payload.Name || payload.FullName || "").trim();
  const email = String(payload.email || payload.Email || payload.username || payload.Username || "").trim();
  const password = String(payload.password || payload.Password || "").trim();
  const role = String(payload.role || payload.Role || "User").trim() || "User";
  const raw = payload.active ?? payload.Active ?? payload.IsActive;
  const active =
    raw === false ||
    raw === 0 ||
    String(raw).toLowerCase() === "n" ||
    String(raw).toLowerCase() === "false" ||
    String(raw).toLowerCase() === "off"
      ? false
      : true;
  return { name, email, password, role, active };
}

async function ensureUserColumns(pool) {
  await pool.request().query(`
    IF OBJECT_ID(N'dbo.Users', N'U') IS NOT NULL AND COL_LENGTH('dbo.Users', 'Role') IS NULL
      ALTER TABLE dbo.Users ADD Role NVARCHAR(50) NULL;

    IF OBJECT_ID(N'dbo.AppUser', N'U') IS NOT NULL AND COL_LENGTH('dbo.AppUser', 'Role') IS NULL
      ALTER TABLE dbo.AppUser ADD Role NVARCHAR(50) NULL;
  `);
}

async function hashPassword(plain, maxLen) {
  const hash = await bcrypt.hash(String(plain), 10);
  if (maxLen && hash.length > maxLen) {
    throw httpError(500, "ไม่สามารถบันทึกรหัสผ่านได้");
  }
  return hash;
}

async function listUsers() {
  await ensureSchema();
  const pool = await poolPromise;
  await ensureUserColumns(pool);

  const tables = await pool.request().query(`
    SELECT TABLE_NAME
    FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = N'dbo'
      AND TABLE_NAME IN (N'Users', N'AppUser')
  `);
  const names = new Set(tables.recordset.map((r) => String(r.TABLE_NAME)));

  if (names.has("Users")) {
    const cols = await columnSet(pool, "Users");
    const nameExpr = cols.has("FullName")
      ? "COALESCE(FullName, Username, N'-')"
      : "COALESCE(Username, N'-')";
    const emailExpr = cols.has("Email")
      ? "COALESCE(Email, Username, N'-')"
      : "COALESCE(Username, N'-')";
    const roleExpr = cols.has("Role") ? "COALESCE(Role, N'User')" : "N'User'";
    const activeExpr = cols.has("IsActive")
      ? `CASE
          WHEN UPPER(CAST(IsActive AS NVARCHAR(20))) IN (N'0', N'N', N'FALSE', N'INACTIVE') THEN 0
          ELSE 1
        END`
      : "1";
    const orderBy = cols.has("Username") ? "Username" : "1";

    const result = await pool.request().query(`
      SELECT
        UserID AS Id,
        ${nameExpr} AS Name,
        ${emailExpr} AS Email,
        ${roleExpr} AS Role,
        ${activeExpr} AS Active
      FROM dbo.Users
      ORDER BY ${orderBy}
    `);
    return result.recordset.map(mapUserRow);
  }

  if (names.has("AppUser")) {
    const cols = await columnSet(pool, "AppUser");
    const nameExpr = cols.has("Name")
      ? "COALESCE(Name, Username, Email, N'-')"
      : "COALESCE(Username, Email, N'-')";
    const emailExpr = cols.has("Email")
      ? "COALESCE(Email, Username, N'-')"
      : "COALESCE(Username, N'-')";
    const roleExpr = cols.has("Role") ? "COALESCE(Role, N'User')" : "N'User'";
    const activeExpr = cols.has("IsActive")
      ? `CASE
          WHEN UPPER(CAST(IsActive AS NVARCHAR(20))) IN (N'0', N'N', N'FALSE', N'INACTIVE') THEN 0
          ELSE 1
        END`
      : "1";
    const orderBy = cols.has("Email") ? "Email" : "1";

    const result = await pool.request().query(`
      SELECT
        Id,
        ${nameExpr} AS Name,
        ${emailExpr} AS Email,
        ${roleExpr} AS Role,
        ${activeExpr} AS Active
      FROM dbo.AppUser
      ORDER BY ${orderBy}
    `);
    return result.recordset.map(mapUserRow);
  }

  return [];
}

async function createUser(payload = {}) {
  const input = userInput(payload);
  if (!input.name || !input.email) {
    throw httpError(400, "กรอกชื่อและอีเมล");
  }
  if (!input.password) {
    throw httpError(400, "กรอกรหัสผ่าน");
  }

  await ensureSchema();
  const pool = await poolPromise;
  await ensureUserColumns(pool);

  const tables = await pool.request().query(`
    SELECT TABLE_NAME
    FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = N'dbo'
      AND TABLE_NAME IN (N'Users', N'AppUser')
  `);
  const names = new Set(tables.recordset.map((r) => String(r.TABLE_NAME)));

  if (names.has("Users")) {
    if (input.email.length > 50) {
      throw httpError(400, "ชื่อผู้ใช้/อีเมลยาวเกิน 50 ตัวอักษร");
    }
    const exists = await pool
      .request()
      .input("username", input.email)
      .query("SELECT TOP 1 UserID FROM dbo.Users WHERE Username = @username");
    if (exists.recordset[0]) {
      throw httpError(409, "มีผู้ใช้นี้อยู่แล้ว");
    }
    const hash = await hashPassword(input.password, 100);
    const cols = await columnSet(pool, "Users");
    const req = pool
      .request()
      .input("username", input.email)
      .input("password", hash)
      .input("fullName", input.name)
      .input("isActive", input.active ? "Y" : "N");
    if (cols.has("Role")) {
      req.input("role", input.role);
      await req.query(`
        INSERT INTO dbo.Users (Username, Password, FullName, IsActive, Role)
        VALUES (@username, @password, @fullName, @isActive, @role)
      `);
    } else {
      await req.query(`
        INSERT INTO dbo.Users (Username, Password, FullName, IsActive)
        VALUES (@username, @password, @fullName, @isActive)
      `);
    }
    const users = await listUsers();
    return users.find((u) => u.email === input.email) || users[users.length - 1];
  }

  if (names.has("AppUser")) {
    const username = input.email.length <= 100 ? input.email : input.email.slice(0, 100);
    const exists = await pool
      .request()
      .input("email", input.email)
      .input("username", username)
      .query("SELECT TOP 1 Id FROM dbo.AppUser WHERE Email = @email OR Username = @username");
    if (exists.recordset[0]) {
      throw httpError(409, "มีผู้ใช้นี้อยู่แล้ว");
    }
    const hash = await hashPassword(input.password, 255);
    const cols = await columnSet(pool, "AppUser");
    const req = pool
      .request()
      .input("email", input.email)
      .input("username", username)
      .input("name", input.name)
      .input("passwordHash", hash);
    if (cols.has("Role")) {
      req.input("role", input.role);
      await req.query(`
        INSERT INTO dbo.AppUser (Email, Username, Name, PasswordHash, Role)
        VALUES (@email, @username, @name, @passwordHash, @role)
      `);
    } else {
      await req.query(`
        INSERT INTO dbo.AppUser (Email, Username, Name, PasswordHash)
        VALUES (@email, @username, @name, @passwordHash)
      `);
    }
    const users = await listUsers();
    return users.find((u) => u.email === input.email) || users[users.length - 1];
  }

  throw httpError(500, "ไม่พบตารางผู้ใช้งาน");
}

async function updateUser(id, payload = {}) {
  const key = String(id || "").trim();
  if (!key) {
    throw httpError(400, "ไม่พบผู้ใช้งาน");
  }
  const input = userInput(payload);

  await ensureSchema();
  const pool = await poolPromise;
  await ensureUserColumns(pool);

  const tables = await pool.request().query(`
    SELECT TABLE_NAME
    FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = N'dbo'
      AND TABLE_NAME IN (N'Users', N'AppUser')
  `);
  const names = new Set(tables.recordset.map((r) => String(r.TABLE_NAME)));

  if (names.has("Users")) {
    const found = await pool
      .request()
      .input("id", key)
      .query("SELECT TOP 1 UserID, Username FROM dbo.Users WHERE CAST(UserID AS NVARCHAR(50)) = @id OR Username = @id");
    const row = found.recordset[0];
    if (!row) {
      throw httpError(404, "ไม่พบผู้ใช้งาน");
    }
    const cols = await columnSet(pool, "Users");
    const nextName = input.name || row.Username;
    const nextUser = input.email || row.Username;
    if (nextUser.length > 50) {
      throw httpError(400, "ชื่อผู้ใช้/อีเมลยาวเกิน 50 ตัวอักษร");
    }
    const req = pool
      .request()
      .input("userId", row.UserID)
      .input("username", nextUser)
      .input("fullName", nextName)
      .input("isActive", input.active ? "Y" : "N");
    const sets = ["Username = @username", "FullName = @fullName", "IsActive = @isActive"];
    if (cols.has("Role")) {
      req.input("role", input.role);
      sets.push("Role = @role");
    }
    if (input.password) {
      req.input("password", await hashPassword(input.password, 100));
      sets.push("Password = @password");
    }
    await req.query(`UPDATE dbo.Users SET ${sets.join(", ")} WHERE UserID = @userId`);
    const users = await listUsers();
    return users.find((u) => u.id === String(row.UserID)) || users.find((u) => u.email === nextUser);
  }

  if (names.has("AppUser")) {
    const found = await pool
      .request()
      .input("id", key)
      .query("SELECT TOP 1 Id, Email, Username, Name FROM dbo.AppUser WHERE CAST(Id AS NVARCHAR(50)) = @id OR Email = @id OR Username = @id");
    const row = found.recordset[0];
    if (!row) {
      throw httpError(404, "ไม่พบผู้ใช้งาน");
    }
    const cols = await columnSet(pool, "AppUser");
    const nextEmail = input.email || row.Email;
    const nextName = input.name || row.Name;
    const nextUser = nextEmail.length <= 100 ? nextEmail : row.Username;
    const req = pool
      .request()
      .input("id", row.Id)
      .input("email", nextEmail)
      .input("username", nextUser)
      .input("name", nextName);
    const sets = ["Email = @email", "Username = @username", "Name = @name"];
    if (cols.has("Role")) {
      req.input("role", input.role);
      sets.push("Role = @role");
    }
    if (input.password) {
      req.input("passwordHash", await hashPassword(input.password, 255));
      sets.push("PasswordHash = @passwordHash");
    }
    await req.query(`UPDATE dbo.AppUser SET ${sets.join(", ")} WHERE Id = @id`);
    const users = await listUsers();
    return users.find((u) => u.id === String(row.Id)) || users.find((u) => u.email === nextEmail);
  }

  throw httpError(404, "ไม่พบผู้ใช้งาน");
}

async function deleteUser(id) {
  const key = String(id || "").trim();
  if (!key) {
    throw httpError(400, "ไม่พบผู้ใช้งาน");
  }

  await ensureSchema();
  const pool = await poolPromise;

  const tables = await pool.request().query(`
    SELECT TABLE_NAME
    FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = N'dbo'
      AND TABLE_NAME IN (N'Users', N'AppUser')
  `);
  const names = new Set(tables.recordset.map((r) => String(r.TABLE_NAME)));

  if (names.has("Users")) {
    const count = await pool.request().query("SELECT COUNT(*) AS n FROM dbo.Users");
    if (Number(count.recordset[0].n) <= 1) {
      throw httpError(400, "ต้องเหลือผู้ใช้งานอย่างน้อย 1 คน");
    }
    const result = await pool
      .request()
      .input("id", key)
      .query("DELETE FROM dbo.Users WHERE CAST(UserID AS NVARCHAR(50)) = @id OR Username = @id");
    if (!result.rowsAffected[0]) {
      throw httpError(404, "ไม่พบผู้ใช้งาน");
    }
    return;
  }

  if (names.has("AppUser")) {
    const count = await pool.request().query("SELECT COUNT(*) AS n FROM dbo.AppUser");
    if (Number(count.recordset[0].n) <= 1) {
      throw httpError(400, "ต้องเหลือผู้ใช้งานอย่างน้อย 1 คน");
    }
    const result = await pool
      .request()
      .input("id", key)
      .query("DELETE FROM dbo.AppUser WHERE CAST(Id AS NVARCHAR(50)) = @id OR Email = @id OR Username = @id");
    if (!result.rowsAffected[0]) {
      throw httpError(404, "ไม่พบผู้ใช้งาน");
    }
    return;
  }

  throw httpError(404, "ไม่พบผู้ใช้งาน");
}

module.exports = {
  getSettings,
  saveSettings,
  getErpCredentials,
  markErpChecked,
  listUsers,
  createUser,
  updateUser,
  deleteUser,
  DEFAULTS,
};
