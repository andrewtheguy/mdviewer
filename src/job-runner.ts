import express from "express";
import {
  startReindex,
  getReindexStatus,
  getLastSourceTimestamp,
  getLastSyncedAt,
  setLastSourceTimestamp,
  fetchTimestampManifest,
  reindexPaths,
  isSyncOperationRunning,
  setSyncOperationRunning,
  isSyncRunning,
  checkNeedsFullReindex,
  setSyncNeedsFullReindex,
} from "./lib/search-db";

class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "HttpError";
  }
}

// Global error handlers to prevent silent crashes
process.on("uncaughtException", (error) => {
  console.error("[JobRunner] Uncaught exception:", error);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("[JobRunner] Unhandled rejection at:", promise, "reason:", reason);
});

const PORT = process.env.JOB_RUNNER_PORT || 3001;
const DEFAULT_SYNC_INTERVAL_S = 900; // 15 minutes
const rawSyncInterval = process.env.SYNC_CHECK_INTERVAL_S;
const parsedSyncInterval = parseInt(rawSyncInterval || "", 10);
const syncIntervalIsValid = Number.isInteger(parsedSyncInterval) && parsedSyncInterval > 0;
if (rawSyncInterval && !syncIntervalIsValid) {
  console.error(`[JobRunner] Invalid SYNC_CHECK_INTERVAL_S="${rawSyncInterval}" (must be a positive integer)`);
  process.exit(1);
}
const SYNC_CHECK_INTERVAL_S = syncIntervalIsValid ? parsedSyncInterval : DEFAULT_SYNC_INTERVAL_S;
const SYNC_ENABLED = process.env.SYNC_ENABLED !== "false";
const S3_INDEX_PREFIX = process.env.S3_INDEX_PREFIX || "";

const app = express();

type TryStartSyncResult =
  | { started: true }
  | { started: false; reason: "needs_reindex" | "already_running" };

// Atomically check conditions and start sync if possible
// Returns whether sync was started, and if not, why
function tryStartSync(): TryStartSyncResult {
  if (checkNeedsFullReindex()) {
    return { started: false, reason: "needs_reindex" };
  }
  if (isSyncOperationRunning()) {
    return { started: false, reason: "already_running" };
  }

  // Acquire lock and start sync
  setSyncOperationRunning(true);
  runSync().catch(error => {
    console.error("[Sync] Error during sync:", error);
  });

  return { started: true };
}

// Internal sync implementation - assumes lock is already held
async function runSync(): Promise<void> {
  try {
    // Fetch timestamp manifest
    const manifest = await fetchTimestampManifest();
    if (!manifest || manifest.length === 0) {
      console.log("[Sync] No timestamp manifest found or empty");
      return;
    }

    // Filter entries by S3_INDEX_PREFIX
    const filteredEntries = S3_INDEX_PREFIX
      ? manifest.filter(e => e.storage_prefix.startsWith(S3_INDEX_PREFIX))
      : manifest;

    if (filteredEntries.length === 0) {
      console.log("[Sync] No entries match S3_INDEX_PREFIX");
      return;
    }

    // Parse timestamps to seconds
    const entriesWithTimestamps = filteredEntries.map(e => ({
      ...e,
      timestampSeconds: Math.floor(new Date(e.chapter_updated_date).getTime() / 1000),
    })).filter(e => !isNaN(e.timestampSeconds) && isFinite(e.timestampSeconds));

    if (entriesWithTimestamps.length === 0) {
      console.log("[Sync] No valid timestamps in manifest");
      return;
    }

    // Get DB timestamp
    const dbTimestamp = getLastSourceTimestamp();
    const earliestTimestamp = Math.min(...entriesWithTimestamps.map(e => e.timestampSeconds));

    // Check if full reindex required
    if (dbTimestamp === null || dbTimestamp < earliestTimestamp) {
      console.log(`[Sync] Full reindex required: DB timestamp=${dbTimestamp}, earliest=${earliestTimestamp}`);
      setSyncNeedsFullReindex(true);
      return;
    }

    // Find entries that need syncing (>= dbTimestamp), doing >= to always resync the last entry with the same timestamp
    // to make sure nothing is missed if multiple entries share the same timestamp
    const entriesToSync = entriesWithTimestamps.filter(e => e.timestampSeconds >= dbTimestamp);

    if (entriesToSync.length === 0) {
      console.log("[Sync] No entries need syncing");
      return;
    }

    console.log(`[Sync] Found ${entriesToSync.length} entries to sync`);

    // Reindex the paths
    const prefixes = entriesToSync.map(e => e.storage_prefix);
    const result = await reindexPaths(prefixes);

    // Only update timestamp if no errors (so failed entries are retried next sync)
    if (result.errors === 0) {
      const maxTimestamp = Math.max(...entriesToSync.map(e => e.timestampSeconds));
      setLastSourceTimestamp(maxTimestamp);
      console.log(`[Sync] Complete: indexed=${result.indexed}, new timestamp=${maxTimestamp}`);
    } else {
      console.log(`[Sync] Complete with errors: indexed=${result.indexed}, errors=${result.errors} (timestamp not updated, will retry)`);
    }
  } catch (error) {
    console.error("[Sync] Error during sync execution:", error);
  } finally {
    setSyncOperationRunning(false);
  }
}

// Check for updated entries and sync incrementally (used by periodic sync)
function checkAndSync(): void {
  const result = tryStartSync();
  if (!result.started) {
    if (result.reason === "needs_reindex") {
      console.log("[Sync] Skipping: full reindex required");
    } else {
      console.log("[Sync] Skipping: reindex or sync already running");
    }
  }
}

app.post("/reindex", (_req, res) => {
  const result = startReindex();
  if (result.success) {
    res.json(result);
  } else {
    throw new HttpError(409, result.message);
  }
});

app.get("/status", (_req, res) => {
  res.json({
    ...getReindexStatus(),
    syncing: isSyncRunning(),
  });
});

app.get("/sync/status", (_req, res) => {
  res.json({
    enabled: SYNC_ENABLED,
    intervalS: SYNC_CHECK_INTERVAL_S,
    lastSourceTimestamp: getLastSourceTimestamp(),
    lastSyncedAt: getLastSyncedAt(),
    needsFullReindex: checkNeedsFullReindex(),
  });
});

app.post("/sync", (_req, res) => {
  const result = tryStartSync();
  if (!result.started) {
    if (result.reason === "needs_reindex") {
      throw new HttpError(409, "Full reindex required before sync can run");
    } else {
      throw new HttpError(409, "Sync or reindex already in progress");
    }
  }
  res.json({ success: true, message: "Sync started" });
});

// Global error handler middleware (4 params required for Express to recognize as error handler)
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  if (err instanceof Error) {
    console.error("[JobRunner] Unhandled error:", err);
    res.status(500).json({ error: err.message });
    return;
  }
  console.error("[JobRunner] Unknown error:", err);
  res.status(500).json({ error: "Internal server error" });
});

app.listen(PORT, () => {
  console.log(`[JobRunner] Running on http://localhost:${PORT}`);

  // Start periodic sync check
  if (SYNC_ENABLED) {
    console.log(`[Sync] Periodic check every ${SYNC_CHECK_INTERVAL_S}s`);
    setInterval(checkAndSync, SYNC_CHECK_INTERVAL_S * 1000);
    // Initial check after 5s startup delay
    setTimeout(checkAndSync, 5000);
  } else {
    console.log("[Sync] Disabled via SYNC_ENABLED=false");
  }
});
