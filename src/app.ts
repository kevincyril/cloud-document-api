import express from "express";
import helmet from "helmet";
import path from "node:path";
import { config } from "./config";
import { pool } from "./database";
import authRouter from "./routes/auth.routes";
import documentRouter from "./routes/documents";
import { errorHandler } from "./middleware/error.middleware";

export const app = express();
app.disable("x-powered-by");
app.set("trust proxy", config.TRUST_PROXY_HOPS === 0 ? false : config.TRUST_PROXY_HOPS);
app.use(helmet());
app.use(express.json({ limit: "100kb" }));
app.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});
app.use("/auth", authRouter);
app.use("/documents", documentRouter);
app.get("/", (_req, res) => {
  res.json({ name: "Cloud Document Processing API", documentation: "/openapi.json", health: "/health" });
});
app.get("/openapi.json", (_req, res) => {
  res.sendFile(path.resolve(__dirname, "../docs/openapi.json"));
});
app.get("/health", async (_req, res) => {
  try {
    const result = await pool.query("SELECT NOW()");
    res.json({ status: "ok", message: "Cloud Document Processing API is running", database: "connected", databaseTime: result.rows[0].now });
  } catch {
    console.error("Database health check failed");
    res.status(503).json({ status: "error", message: "Database connection failed" });
  }
});
app.use((_req, res) => {
  res.status(404).json({ status: "error", message: "Route not found" });
});
app.use(errorHandler);
