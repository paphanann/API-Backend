const useTrusted =
  String(process.env.DB_TRUSTED || "").toLowerCase() === "true" ||
  !process.env.DB_USER;

const sql = useTrusted ? require("mssql/msnodesqlv8") : require("mssql");

const config = useTrusted
  ? {
      server: process.env.DB_SERVER,
      database: process.env.DB_DATABASE,
      driver: "msnodesqlv8",
      options: {
        trustedConnection: true,
        encrypt: false,
        trustServerCertificate: true,
      },
      pool: {
        max: 10,
        min: 0,
        idleTimeoutMillis: 30000,
      },
    }
  : {
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      server: process.env.DB_SERVER,
      database: process.env.DB_DATABASE,
      options: {
        encrypt: false,
        trustServerCertificate: true,
      },
      pool: {
        max: 10,
        min: 0,
        idleTimeoutMillis: 30000,
      },
    };

const poolPromise = new sql.ConnectionPool(config)
  .connect()
  .then((pool) => {
    console.log(
      useTrusted
        ? "SQL Server connected (Windows auth)"
        : "SQL Server connected"
    );
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
