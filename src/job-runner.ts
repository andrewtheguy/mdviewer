import express from "express";
import { s3 } from "./lib/s3";
import {
  addDocuments,
  deleteAllDocuments,
  keyToId,
  type S3FileDocument,
} from "./lib/search-db";

// Global error handlers to prevent silent crashes
process.on("uncaughtException", (error) => {
  console.error("[JobRunner] Uncaught exception:", error);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("[JobRunner] Unhandled rejection at:", promise, "reason:", reason);
});

const PORT = process.env.JOB_RUNNER_PORT || 3001;

const INDEXABLE_EXTENSIONS = ["txt", "md"];
const CONTENT_PREVIEW_LENGTH = 500;
const INDEX_BATCH_SIZE = 100;
const S3_FETCH_TIMEOUT_MS = 30000; // 30 seconds per file

// In-memory status
interface ReindexStatus {
  running: boolean;
  progress: {
    current: number;
    total: number;
  };
  lastResult: {
    success: boolean;
    total: number;
    indexed: number;
    skipped: number;
    errors: number;
    completedAt: string;
  } | null;
}

let status: ReindexStatus = {
  running: false,
  progress: { current: 0, total: 0 },
  lastResult: null,
};

function isIndexable(key: string): boolean {
  const ext = key.toLowerCase().split(".").pop();
  return ext ? INDEXABLE_EXTENSIONS.includes(ext) : false;
}

function getExtension(key: string): string {
  return key.toLowerCase().split(".").pop() || "";
}

function getBasename(key: string): string {
  return key.split("/").pop() || key;
}

function getPath(key: string): string {
  const parts = key.split("/");
  if (parts.length <= 1) return "";
  return parts.slice(0, -1).join("/");
}

// Timeout wrapper for async operations
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout after ${ms}ms: ${label}`)), ms)
    ),
  ]);
}

async function runReindex() {
  const result = {
    total: 0,
    indexed: 0,
    skipped: 0,
    errors: 0,
  };

  try {
    console.log("[JobRunner] Deleting all documents...");
    deleteAllDocuments();

    console.log("[JobRunner] Listing S3 files...");
    const listResult = await s3.list();
    const objects = listResult.contents || [];

    result.total = objects.length;
    status.progress.total = objects.length;

    const indexableObjects = objects.filter(
      (obj) => obj.key && isIndexable(obj.key)
    );
    result.skipped = objects.length - indexableObjects.length;
    console.log(
      `[JobRunner] Found ${objects.length} total files, ${indexableObjects.length} indexable`
    );

    let pendingDocuments: S3FileDocument[] = [];

    for (let i = 0; i < indexableObjects.length; i++) {
      const obj = indexableObjects[i]!;
      const key = obj.key!;

      try {
        const content = await withTimeout(
          s3.file(key).text(),
          S3_FETCH_TIMEOUT_MS,
          `fetch ${key}`
        );
        const contentPreview = content.slice(0, CONTENT_PREVIEW_LENGTH);
        const lastModified = obj.lastModified
          ? new Date(obj.lastModified)
          : new Date();

        pendingDocuments.push({
          id: keyToId(key),
          key,
          name: getBasename(key),
          extension: getExtension(key),
          path: getPath(key),
          size: obj.size ?? 0,
          lastModified: lastModified.getTime(),
          lastModifiedISO: lastModified.toISOString(),
          content,
          contentPreview,
        });
      } catch (err) {
        console.error(`[JobRunner] Failed to fetch "${key}":`, err);
        result.errors++;
      }

      if (pendingDocuments.length >= INDEX_BATCH_SIZE) {
        try {
          addDocuments(pendingDocuments);
          result.indexed += pendingDocuments.length;
        } catch (err) {
          console.error("[JobRunner] Failed to add batch to SQLite:", err);
          result.errors += pendingDocuments.length;
        }
        pendingDocuments = [];
      }

      status.progress.current = i + 1;
      if ((i + 1) % 100 === 0 || i === indexableObjects.length - 1) {
        console.log(
          `[JobRunner] Processed ${i + 1}/${indexableObjects.length} files (indexed: ${result.indexed})...`
        );
      }
    }

    if (pendingDocuments.length > 0) {
      console.log(`[JobRunner] Adding final ${pendingDocuments.length} documents...`);
      try {
        addDocuments(pendingDocuments);
        result.indexed += pendingDocuments.length;
      } catch (err) {
        console.error("[JobRunner] Failed to add final batch to SQLite:", err);
        result.errors += pendingDocuments.length;
      }
    }

    console.log("[JobRunner] Reindex completed successfully!", result);
    status.lastResult = {
      success: true,
      ...result,
      completedAt: new Date().toISOString(),
    };
  } catch (error) {
    console.error("[JobRunner] Reindex error:", error);
    status.lastResult = {
      success: false,
      ...result,
      completedAt: new Date().toISOString(),
    };
  } finally {
    status.running = false;
    status.progress = { current: 0, total: 0 };
  }
}

const app = express();

app.post("/reindex", (_req, res) => {
  if (status.running) {
    res.status(409).json({ error: "Reindex already in progress" });
    return;
  }

  status.running = true;
  status.progress = { current: 0, total: 0 };

  // Run reindex in background (don't await)
  runReindex().catch((err) => {
    console.error("[JobRunner] Unexpected error in runReindex:", err);
    status.running = false;
    status.lastResult = {
      success: false,
      total: 0,
      indexed: 0,
      skipped: 0,
      errors: 1,
      completedAt: new Date().toISOString(),
    };
  });

  res.json({
    success: true,
    message: "Reindex started",
  });
});

app.get("/status", (_req, res) => {
  res.json(status);
});

app.listen(PORT, () => {
  console.log(`[JobRunner] Running on http://localhost:${PORT}`);
});
