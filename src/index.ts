import express from "express";
import path from "path";
import { search, listDocuments, getRecentDocuments, getDocument, getDocumentMetadata, browseFolder, getCollections, getCollectionTitles, getCollectionTranscripts, getStats, SCHEMA_VERSION, getSchemaVersion, getSyncNeedsFullReindex, type SortField, type SortOrder } from "./lib/search-db";

// Validate and decode base64 URL-safe encoded key
// Throws Error if input contains invalid base64url characters
function decodeKey(encoded: string): string {
  // base64url allows: A-Z, a-z, 0-9, -, _ (no padding required)
  if (!/^[A-Za-z0-9_-]*$/.test(encoded)) {
    throw new Error("Invalid base64url characters");
  }
  return Buffer.from(encoded, "base64url").toString("utf-8");
}

const JOB_RUNNER_URL = process.env.JOB_RUNNER_URL || "http://localhost:3001";
const PORT = parseInt(process.env.PORT || "3000", 10);
const isProduction = process.env.NODE_ENV === "production";
const DEFAULT_FETCH_TIMEOUT_MS = 10000;

// Schema version check - block API until reindex completes if mismatch
let needsReindex = false;

function checkSchemaVersion(): void {
  const dbVersion = getSchemaVersion();
  needsReindex = dbVersion !== SCHEMA_VERSION;
  if (needsReindex) {
    console.log(`[Server] Schema version mismatch: DB has ${dbVersion}, expected ${SCHEMA_VERSION}. API blocked until reindex completes.`);
  } else {
    console.log(`[Server] Schema version OK: ${SCHEMA_VERSION}`);
  }
}

// Parse and validate pagination parameters from query string
function parsePagination(
  query: { limit?: string; offset?: string },
  options: { defaultLimit?: number; maxLimit?: number } = {}
): { limit: number; offset: number } {
  const { defaultLimit = 50, maxLimit = 100 } = options;

  let limit = parseInt(query.limit || String(defaultLimit), 10);
  if (isNaN(limit) || limit < 0) {
    limit = defaultLimit;
  } else if (limit > maxLimit) {
    limit = maxLimit;
  }

  let offset = parseInt(query.offset || "0", 10);
  if (isNaN(offset) || offset < 0) {
    offset = 0;
  }

  return { limit, offset };
}

// Parse and validate sort parameters from query string
function parseSortParams(query: { sortBy?: string; sortOrder?: string }): { sortBy?: SortField; sortOrder?: SortOrder } {
  const sortBy = query.sortBy === "name" || query.sortBy === "date" ? query.sortBy : undefined;
  const sortOrder = query.sortOrder === "asc" || query.sortOrder === "desc" ? query.sortOrder : undefined;
  return { sortBy, sortOrder };
}

interface FetchWithTimeoutOptions extends RequestInit {
  timeoutMs?: number;
}

type FetchResult<T> =
  | { ok: true; data: T; status: number }
  | { ok: false; error: string; status: number };

async function fetchWithTimeout<T = unknown>(
  url: string,
  options: FetchWithTimeoutOptions = {}
): Promise<FetchResult<T>> {
  const { timeoutMs = DEFAULT_FETCH_TIMEOUT_MS, ...fetchOptions } = options;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...fetchOptions,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      return {
        ok: false,
        error: text || response.statusText,
        status: response.status,
      };
    }

    try {
      const data = await response.json() as T;
      return { ok: true, data, status: response.status };
    } catch (parseError) {
      return {
        ok: false,
        error: parseError instanceof SyntaxError ? "Invalid JSON response" : "Failed to parse response",
        status: response.status,
      };
    }
  } catch (error) {
    clearTimeout(timeoutId);

    if (error instanceof Error && error.name === "AbortError") {
      return { ok: false, error: "Request timed out", status: 504 };
    }

    return { ok: false, error: "Service unavailable", status: 502 };
  }
}

const app = express();

app.use(express.json());

// Check schema version on startup
checkSchemaVersion();

// Middleware to block API routes when reindex is required
// Allows reindex endpoints through so users can trigger the reindex
app.use("/api", (req, res, next) => {
  // Re-check schema version on each blocked request (clears needsReindex when version matches)
  if (needsReindex) {
    const dbVersion = getSchemaVersion();
    if (dbVersion === SCHEMA_VERSION) {
      needsReindex = false;
      console.log("[Server] Schema version now matches, API unblocked");
    }
  }

  // Also check if sync requires full reindex
  const syncNeedsReindex = getSyncNeedsFullReindex();

  // Allow exact /search/reindex or subpaths like /search/reindex/status
  const isReindexRoute = req.path === "/search/reindex" || req.path.startsWith("/search/reindex/");
  if ((needsReindex || syncNeedsReindex) && !isReindexRoute) {
    res.status(503).json({
      error: "Reindex required",
      needsReindex: true,
      reason: needsReindex ? "schema_mismatch" : "sync_outdated",
    });
    return;
  }
  next();
});

// Document API Routes (served from database)
app.get("/api/documents/list", (req, res) => {
  try {
    const { limit, offset } = parsePagination(req.query as { limit?: string; offset?: string }, { defaultLimit: 100 });
    const result = listDocuments({ limit, offset });
    res.json({ objects: result.objects, total: result.total });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : "Failed to list objects",
    });
  }
});

// Browse folder endpoint - returns folders and paginated files at a path
app.get("/api/documents/browse", (req, res) => {
  try {
    const requestPath = (req.query.path as string) || "";
    const { limit, offset } = parsePagination(req.query as { limit?: string; offset?: string });
    const result = browseFolder({ path: requestPath, limit, offset });
    res.json(result);
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : "Failed to browse folder",
    });
  }
});

app.get("/api/documents/download", (req, res) => {
  try {
    const encodedKey = req.query.key as string | undefined;
    if (!encodedKey) {
      res.status(400).json({ error: "Missing key parameter" });
      return;
    }

    let key: string;
    try {
      key = decodeKey(encodedKey);
    } catch {
      res.status(400).json({ error: "Invalid key parameter" });
      return;
    }

    const doc = getDocument(key);

    if (!doc) {
      res.status(404).json({ error: "File not found" });
      return;
    }

    // Determine content type based on extension
    const contentType = doc.extension === "md" ? "text/markdown" : "text/plain";

    // Extract basename and encode for Content-Disposition header (RFC 5987)
    const basename = key.split("/").pop() || key;
    const encodedFilename = encodeURIComponent(basename).replace(/'/g, "%27");

    res.setHeader("Content-Type", `${contentType}; charset=utf-8`);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename*=UTF-8''${encodedFilename}`
    );
    res.send(doc.content);
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : "Failed to download file",
    });
  }
});

app.get("/api/documents/preview", (req, res) => {
  try {
    const encodedKey = req.query.key as string | undefined;
    if (!encodedKey) {
      res.status(400).json({ error: "Missing key parameter" });
      return;
    }
    const key = decodeKey(encodedKey);
    const ext = key.toLowerCase().split(".").pop();

    // Only allow preview for .txt and .md files
    if (ext !== "txt" && ext !== "md") {
      res.status(400).json({
        error: "Preview is only supported for .txt and .md files",
      });
      return;
    }

    const doc = getDocument(key);

    if (!doc) {
      res.status(404).json({ error: "File not found" });
      return;
    }

    // Get metadata for the document
    const metadata = getDocumentMetadata(key);

    res.json({
      content: doc.content,
      collection: metadata?.collection ?? null,
      title: metadata?.title ?? null,
      creationDate: metadata?.creationDate ?? null,
      creationDateISO: metadata?.creationDateISO ?? null,
    });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : "Failed to preview file",
    });
  }
});

// Recent files endpoint - returns recently updated .txt and .md files from database
app.get("/api/documents/recent", (req, res) => {
  try {
    const { limit, offset } = parsePagination(req.query as { limit?: string; offset?: string });

    // Validate typeFilter against allowed values
    const allowedTypes = ["all", "txt", "md"] as const;
    const rawType = (req.query.type as string) || "all";
    const typeFilter: "all" | "txt" | "md" = allowedTypes.includes(rawType as typeof allowedTypes[number])
      ? (rawType as "all" | "txt" | "md")
      : "all";

    const result = getRecentDocuments({
      limit,
      offset,
      type: typeFilter,
    });

    res.json({
      files: result.files,
      totalFiles: result.totalFiles,
    });
  } catch (error) {
    res.status(500).json({
      error:
        error instanceof Error ? error.message : "Failed to get recent files",
    });
  }
});

// Search API Routes
app.get("/api/search", (req, res) => {
  try {
    const query = (req.query.q as string) || "";
    const limit = parseInt((req.query.limit as string) || "20", 10);
    const offset = parseInt((req.query.offset as string) || "0", 10);

    if (!query.trim()) {
      res.json({ hits: [], query: "", totalHits: 0 });
      return;
    }

    const results = search(query, { limit, offset });

    res.json({
      hits: results.hits,
      query: results.query,
      totalHits: results.totalHits,
      processingTimeMs: results.processingTimeMs,
    });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : "Search failed",
    });
  }
});

app.post("/api/search/reindex", async (_req, res) => {
  const result = await fetchWithTimeout(`${JOB_RUNNER_URL}/reindex`, {
    method: "POST",
  });

  if (result.ok) {
    res.json(result.data);
  } else {
    res.status(result.status).json({ error: result.error });
  }
});

app.get("/api/search/reindex/status", async (_req, res) => {
  const result = await fetchWithTimeout<{ running: boolean }>(`${JOB_RUNNER_URL}/status`);

  if (result.ok) {
    res.json(result.data);
  } else {
    res.status(result.status).json({ running: false, error: result.error });
  }
});

app.get("/api/search/stats", (_req, res) => {
  try {
    const stats = getStats();
    res.json(stats);
  } catch (error) {
    console.error("Failed to get index stats:", error);
    res.json({
      numberOfDocuments: 0,
      isIndexing: false,
    });
  }
});

// Collections API Routes
app.get("/api/collections", (req, res) => {
  try {
    const { limit, offset } = parsePagination(req.query as { limit?: string; offset?: string });
    const { sortBy, sortOrder } = parseSortParams(req.query as { sortBy?: string; sortOrder?: string });
    const result = getCollections({ limit, offset, sortBy, sortOrder });
    res.json(result);
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : "Failed to get collections",
    });
  }
});

app.get("/api/collections/:collection", (req, res) => {
  try {
    const { collection } = req.params;
    const { limit, offset } = parsePagination(req.query as { limit?: string; offset?: string });
    const { sortBy, sortOrder } = parseSortParams(req.query as { sortBy?: string; sortOrder?: string });
    // Return grouped titles for this collection
    const result = getCollectionTitles(collection, { limit, offset, sortBy, sortOrder });
    res.json(result);
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : "Failed to get collection titles",
    });
  }
});

app.get("/api/collections/:collection/transcripts/:title", (req, res) => {
  try {
    const { collection, title: titleParam } = req.params;
    // Translate placeholder to null for querying documents with NULL title
    const title = titleParam === "__NO_TITLE_e4f7b2c9__" ? null : titleParam;
    const { limit, offset } = parsePagination(req.query as { limit?: string; offset?: string });
    const { sortBy, sortOrder } = parseSortParams(req.query as { sortBy?: string; sortOrder?: string });
    // Return transcripts for this specific title within the collection
    const result = getCollectionTranscripts(collection, { limit, offset, title, sortBy, sortOrder });
    res.json(result);
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : "Failed to get collection transcripts",
    });
  }
});

// Serve static files in production
if (isProduction) {
  const distPath = path.join(import.meta.dirname, "../dist");
  app.use(express.static(distPath));

  // Fallback to index.html for SPA routing, but return 404 for unknown API routes
  app.get("/{*splat}", (req, res) => {
    if (req.path.startsWith("/api")) {
      res.status(404).json({ error: "Not Found" });
      return;
    }
    res.sendFile(path.join(distPath, "index.html"));
  });
}

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
