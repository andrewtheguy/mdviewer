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

// Metadata interface for folder metadata.json files
interface FolderMetadata {
  creation_date: string;  // ISO 8601
  version: number;
  type: string;           // "transcribefoldermetadata"
  collection: string;
  title: string;
}

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

const status: ReindexStatus = {
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

// Check if an error indicates S3 "not found" (NoSuchKey)
function isS3NotFoundError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const err = error as Record<string, unknown>;
  // AWS SDK v3 uses name or code for error identification
  return err.name === "NoSuchKey" || err.code === "NoSuchKey";
}

// Fetch and parse metadata.json from a folder
async function fetchFolderMetadata(folderPath: string): Promise<FolderMetadata | null> {
  const metadataKey = folderPath ? `${folderPath}/metadata.json` : "metadata.json";
  try {
    const content = await withTimeout(s3.file(metadataKey).text(), S3_FETCH_TIMEOUT_MS, `fetch ${metadataKey}`);
    const metadata = JSON.parse(content) as Record<string, unknown>;

    // Validate type
    if (metadata.type !== "transcribefoldermetadata") {
      console.warn(`[JobRunner] Invalid metadata type at ${metadataKey}: expected "transcribefoldermetadata", got "${metadata.type}"`);
      return null;
    }

    // Validate required fields
    if (typeof metadata.collection !== "string" || typeof metadata.title !== "string") {
      console.warn(`[JobRunner] Missing collection or title in metadata at ${metadataKey}`);
      return null;
    }

    return {
      creation_date: typeof metadata.creation_date === "string" ? metadata.creation_date : "",
      version: typeof metadata.version === "number" ? metadata.version : 0,
      type: metadata.type as string,
      collection: metadata.collection as string,
      title: metadata.title as string,
    };
  } catch (error) {
    // Silently return null for "not found" errors
    if (isS3NotFoundError(error)) {
      return null;
    }
    // Log other errors
    console.warn(`[JobRunner] Failed to fetch metadata at ${metadataKey}:`, error);
    return null;
  }
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

    // Group files by folder to fetch metadata once per folder
    const filesByFolder = new Map<string, typeof indexableObjects>();
    for (const obj of indexableObjects) {
      const folderPath = getPath(obj.key!);
      if (!filesByFolder.has(folderPath)) {
        filesByFolder.set(folderPath, []);
      }
      filesByFolder.get(folderPath)!.push(obj);
    }

    console.log(`[JobRunner] Found ${filesByFolder.size} unique folders`);

    // Cache for folder metadata
    const folderMetadataCache = new Map<string, FolderMetadata | null>();

    // Fetch metadata for all folders in parallel (with concurrency limit)
    const folderPaths = Array.from(filesByFolder.keys());
    const METADATA_FETCH_CONCURRENCY = 10;
    for (let i = 0; i < folderPaths.length; i += METADATA_FETCH_CONCURRENCY) {
      const batch = folderPaths.slice(i, i + METADATA_FETCH_CONCURRENCY);
      const results = await Promise.all(
        batch.map(async (folderPath) => {
          const metadata = await fetchFolderMetadata(folderPath);
          return { folderPath, metadata };
        })
      );
      for (const { folderPath, metadata } of results) {
        folderMetadataCache.set(folderPath, metadata);
      }
    }

    const foldersWithMetadata = Array.from(folderMetadataCache.values()).filter(m => m !== null).length;
    console.log(`[JobRunner] Found metadata.json in ${foldersWithMetadata}/${filesByFolder.size} folders`);

    let pendingDocuments: S3FileDocument[] = [];
    let processedCount = 0;

    for (let i = 0; i < indexableObjects.length; i++) {
      const obj = indexableObjects[i]!;
      const key = obj.key!;
      const folderPath = getPath(key);

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

        // Get metadata for this file's folder
        const metadata = folderMetadataCache.get(folderPath) ?? null;

        // Determine creation date - use metadata if available and valid, otherwise S3 lastModified
        let creationDate: Date;
        let creationDateISO: string;
        if (metadata?.creation_date) {
          const parsed = new Date(metadata.creation_date);
          if (!isNaN(parsed.getTime())) {
            creationDate = parsed;
            creationDateISO = metadata.creation_date;
          } else {
            creationDate = lastModified;
            creationDateISO = lastModified.toISOString();
          }
        } else {
          creationDate = lastModified;
          creationDateISO = lastModified.toISOString();
        }

        pendingDocuments.push({
          id: keyToId(key),
          key,
          name: getBasename(key),
          extension: getExtension(key),
          path: folderPath,
          size: obj.size ?? 0,
          lastModified: lastModified.getTime(),
          lastModifiedISO: lastModified.toISOString(),
          content,
          contentPreview,
          collection: metadata?.collection ?? null,
          title: metadata?.title ?? null,
          creationDate: creationDate.getTime(),
          creationDateISO,
          hasMetadata: metadata !== null,
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

      processedCount++;
      status.progress.current = processedCount;
      if (processedCount % 100 === 0 || processedCount === indexableObjects.length) {
        console.log(
          `[JobRunner] Processed ${processedCount}/${indexableObjects.length} files (indexed: ${result.indexed})...`
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
