import { Pool } from "pg";
import { readFileSync } from "node:fs";
import { config } from "./config";

export const pool = new Pool({
  host: process.env.DB_HOST,
  port: config.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 30000,
  max: 5,
  ssl: config.DB_SSL === "true" ? {
    rejectUnauthorized: true,
    ...(process.env.DB_SSL_CA_FILE ? { ca: readFileSync(process.env.DB_SSL_CA_FILE, "utf8") } : {}),
  } : false,
});

pool.on("error", () => {
  console.error("Unexpected idle database connection error");
});
