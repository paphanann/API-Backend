const useWindowsAuth = String(process.env.DB_AUTH || "").trim().toLowerCase() === "windows";
const sql = useWindowsAuth ? require("mssql/msnodesqlv8") : require("mssql");

const poolOptions = {
  max: 10,
  min: 0,
  idleTimeoutMillis: 30000,
};

const config = useWindowsAuth
  ? {
      server: process.env.DB_SERVER,
      database: process.env.DB_DATABASE,
      driver: "msnodesqlv8",
      connectionTimeout: 30000,
      requestTimeout: 30000,
      pool: poolOptions,
      options: {
        trustedConnection: true,
        trustServerCertificate: true,
      },
    }
  : {
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      server: process.env.DB_SERVER,
      database: process.env.DB_DATABASE,
      port: 1433,
      connectionTimeout: 30000,
      requestTimeout: 30000,
      pool: poolOptions,
      options: {
        encrypt: true,
        trustServerCertificate: true,
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
