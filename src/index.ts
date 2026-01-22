import express from "express";
import path from "path";
import { search, listDocuments, getRecentDocuments, getDocument } from "./lib/search-db";
import { getIndexStats } from "./lib/indexer";

// Decode base64 URL-safe encoded key
function decodeKey(encoded: string): string {
  return Buffer.from(encoded, "base64url").toString("utf-8");
}

const JOB_RUNNER_URL = process.env.JOB_RUNNER_URL || "http://localhost:3001";
const PORT = parseInt(process.env.PORT || "3000", 10);
const isProduction = process.env.NODE_ENV === "production";
const DEFAULT_FETCH_TIMEOUT_MS = 10000;

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

// S3 API Routes (now served from database)
app.get("/api/s3/list", (_req, res) => {
  try {
    const objects = listDocuments();
    res.json({ objects });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : "Failed to list objects",
    });
  }
});
app.get("/api/s3/download", (req, res) => {
  try {
    const encodedKey = req.query.key as string | undefined;
    if (!encodedKey) {
      res.status(400).json({ error: "Missing key parameter" });
      return;
    }
    const key = decodeKey(encodedKey);
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

app.get("/api/s3/preview", (req, res) => {
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

    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.send(doc.content);
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : "Failed to preview file",
    });
  }
});

// Recent files endpoint - returns recently updated .txt and .md files from database
app.get("/api/s3/recent", (req, res) => {
  try {
    const limit = parseInt((req.query.limit as string) || "50", 10);
    const offset = parseInt((req.query.offset as string) || "0", 10);
    const typeFilter = (req.query.type as string) || "all"; // "all", "txt", or "md"

    const result = getRecentDocuments({
      limit,
      offset,
      type: typeFilter as "all" | "txt" | "md",
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

app.get("/api/search/stats", async (_req, res) => {
  try {
    const stats = await getIndexStats();
    res.json(stats);
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : "Failed to get stats",
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
