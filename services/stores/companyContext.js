const DEFAULT_COMPANY_ID = "default";

let cached = null;

function resolveCompanyId(settings = {}) {
  const code = String(settings.companyCode || "").trim();
  const database = String(settings.database || "").trim();
  const env = String(process.env.SAP_COMPANY_DB || "").trim();
  return code || database || env || DEFAULT_COMPANY_ID;
}

async function currentCompanyId() {
  if (cached) return cached;
  const settingsStore = require("./settingsStore");
  const settings = await settingsStore.getSettings();
  cached = resolveCompanyId(settings);
  return cached;
}

function clearCompanyCache() {
  cached = null;
}

module.exports = {
  DEFAULT_COMPANY_ID,
  resolveCompanyId,
  currentCompanyId,
  clearCompanyCache,
};
