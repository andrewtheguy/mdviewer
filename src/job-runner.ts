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
  try {
    const result = startReindex();
    if (result.success) {
      res.json(result);
    } else {
      res.status(409).json({ error: result.message });
    }
  } catch (err) {
    console.error("[JobRunner] Failed to start reindex:", err);
    res.status(500).json({ error: "Failed to start reindex" });
  }
});

app.get("/status", (_req, res) => {
  try {
    res.json(getReindexStatus());
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[JobRunner] Failed to get reindex status:", err);
    res.status(500).json({ error: "Failed to get reindex status", details: message });
  }
});

app.listen(PORT, () => {
  console.log(`[JobRunner] Running on http://localhost:${PORT}`);
});
