const sql = require("mssql");

const config = {
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  server: process.env.DB_SERVER,
  database: process.env.DB_DATABASE,
  port: 1433,

options: {
  encrypt: true,
  trustServerCertificate: true,
},

  connectionTimeout: 30000,
  requestTimeout: 30000,

  pool: {
    max: 10,
    min: 0,
    idleTimeoutMillis: 30000,
  },
};

const poolPromise = new sql.ConnectionPool(config)
  .connect()
  .then((pool) => {
    console.log("SQL Server connected");
    return pool;
  })
  .catch((err) => {
    console.error("Database connection failed:", err);
    throw err;
  });

poolPromise.catch(() => {});

module.exports = {
  sql,
  poolPromise,
};
