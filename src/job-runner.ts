import express from "express";
import { startReindex, getReindexStatus } from "./lib/search-db";

// Global error handlers to prevent silent crashes
process.on("uncaughtException", (error) => {
  console.error("[JobRunner] Uncaught exception:", error);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("[JobRunner] Unhandled rejection at:", promise, "reason:", reason);
});

const PORT = process.env.JOB_RUNNER_PORT || 3001;

const app = express();

app.post("/reindex", (_req, res) => {
  const result = startReindex();
  if (result.success) {
    res.json(result);
  } else {
    res.status(409).json({ error: result.message });
  }
});

app.get("/status", (_req, res) => {
  res.json(getReindexStatus());
});

app.listen(PORT, () => {
  console.log(`[JobRunner] Running on http://localhost:${PORT}`);
});
