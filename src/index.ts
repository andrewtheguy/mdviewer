import express from "express";
import path from "path";
import { search, listDocuments, getRecentDocuments, getDocument, getDocumentMetadata, browseFolder, getCollections, getCollectionTitles, getCollectionDocuments, getStats, checkNeedsFullReindex, type SortField, type SortOrder } from "./lib/search-db";
import {
  clearSessionCookie,
  createSession as createAuthSession,
  extractSessionToken,
  getSessionCookie,
  initAuthFromEnv,
  invalidateSession,
  isAuthDisabled,
  isRequestAuthenticated,
  verifyCredentials,
} from "./lib/auth";

class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "HttpError";
  }
}

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
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 60_000;

type LoginAttemptRecord = { count: number; resetAt: number };
const loginAttempts = new Map<string, LoginAttemptRecord>();

function checkLoginRateLimit(ip: string): boolean {
  const now = Date.now();
  const record = loginAttempts.get(ip);
  if (!record || now >= record.resetAt) {
    loginAttempts.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    return true;
  }
  record.count += 1;
  return record.count <= LOGIN_MAX_ATTEMPTS;
}

function clearLoginAttempts(ip: string): void {
  loginAttempts.delete(ip);
}

function isSecureRequest(req: express.Request): boolean {
  return req.secure || req.get("x-forwarded-proto") === "https";
}

function getClientIp(req: express.Request): string {
  return req.ip || req.socket.remoteAddress || "unknown";
}

try {
  const authConfig = initAuthFromEnv();
  if (authConfig.disabled) {
    console.warn("[auth] AUTH_DISABLED=true, authentication is disabled");
  } else {
    console.log("[auth] Authentication enabled");
  }
} catch (error) {
  const message = error instanceof Error ? error.message : "Unknown auth configuration error";
  console.error(`[auth] Failed to initialize authentication: ${message}`);
  process.exit(1);
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

interface FetchOrThrowOptions extends RequestInit {
  timeoutMs?: number;
}

async function fetchOrThrow<T = unknown>(
  url: string,
  options: FetchOrThrowOptions = {}
): Promise<T> {
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
      let text = "";
      try {
        text = await response.text();
      } catch {
        // Ignore parse errors, use empty string
      }
      throw new HttpError(response.status, text || response.statusText);
    }

    try {
      return await response.json() as T;
    } catch (parseError) {
      throw new HttpError(
        500,
        parseError instanceof SyntaxError ? "Invalid JSON response" : "Failed to parse response"
      );
    }
  } catch (error) {
    clearTimeout(timeoutId);

    if (error instanceof HttpError) {
      throw error;
    }

    if (error instanceof Error && error.name === "AbortError") {
      throw new HttpError(504, "Request timed out");
    }

    throw new HttpError(502, "Service unavailable");
  }
}

const app = express();

app.use(express.json());

app.post("/api/auth/login", async (req, res) => {
  if (isAuthDisabled()) {
    res.json({ ok: true, authDisabled: true });
    return;
  }

  const ip = getClientIp(req);
  if (!checkLoginRateLimit(ip)) {
    console.warn(`[auth] rate-limited login from ${ip}`);
    res.status(429).json({ error: "Too many attempts, try again later" });
    return;
  }

  const body = req.body as { username?: unknown; password?: unknown };
  if (typeof body.username !== "string" || typeof body.password !== "string") {
    res.status(400).json({ error: "Missing username or password" });
    return;
  }

  // eslint-disable-next-line no-control-regex
  const safeUsername = body.username.replace(new RegExp("[\\x00-\\x1f\\x7f]", "g"), "").slice(0, 64);
  if (!(await verifyCredentials(body.username, body.password))) {
    console.warn(`[auth] invalid login attempt from ${ip} (user: ${safeUsername})`);
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }

  clearLoginAttempts(ip);
  console.log(`[auth] login success for user "${safeUsername}" from ${ip}`);
  const token = createAuthSession(body.username);
  res.setHeader("Set-Cookie", getSessionCookie(token, isSecureRequest(req)));
  res.json({ ok: true });
});

app.post("/api/auth/logout", (req, res) => {
  const token = extractSessionToken(req);
  if (token) {
    invalidateSession(token);
  }
  res.setHeader("Set-Cookie", clearSessionCookie());
  res.json({ ok: true });
});

app.get("/api/auth/check", (req, res) => {
  if (isAuthDisabled() || isRequestAuthenticated(req)) {
    res.json({ authenticated: true });
    return;
  }
  res.status(401).json({ authenticated: false });
});

const appApi = express.Router();

appApi.use((req, res, next) => {
  if (isAuthDisabled() || isRequestAuthenticated(req)) {
    next();
    return;
  }
  res.status(401).json({ error: "Unauthorized" });
});

// Middleware to block app API routes when reindex is required.
// Allow reindex endpoints through so users can trigger the reindex.
appApi.use((req, res, next) => {
  const isReindexRoute = req.path === "/search/reindex" || req.path.startsWith("/search/reindex/");
  if (checkNeedsFullReindex() && !isReindexRoute) {
    res.status(503).json({
      error: "Reindex required",
      needsReindex: true,
    });
    return;
  }
  next();
});

// Document API Routes (served from database)
appApi.get("/documents/list", (req, res) => {
  const { limit, offset } = parsePagination(req.query as { limit?: string; offset?: string }, { defaultLimit: 100 });
  const result = listDocuments({ limit, offset });
  res.json({ objects: result.objects, total: result.total });
});

// Browse folder endpoint - returns folders and paginated files at a path
appApi.get("/documents/browse", (req, res) => {
  const requestPath = (req.query.path as string) || "";
  const { limit, offset } = parsePagination(req.query as { limit?: string; offset?: string });
  const result = browseFolder({ path: requestPath, limit, offset });
  res.json(result);
});

appApi.get("/documents/download", (req, res) => {
  const encodedKey = req.query.key as string | undefined;
  if (!encodedKey) {
    throw new HttpError(400, "Missing key parameter");
  }

  let key: string;
  try {
    key = decodeKey(encodedKey);
  } catch {
    throw new HttpError(400, "Invalid key parameter");
  }

  const doc = getDocument(key);

  if (!doc) {
    throw new HttpError(404, "File not found");
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
});

appApi.get("/documents/preview", (req, res) => {
  const encodedKey = req.query.key as string | undefined;
  if (!encodedKey) {
    throw new HttpError(400, "Missing key parameter");
  }

  let key: string;
  try {
    key = decodeKey(encodedKey);
  } catch {
    throw new HttpError(400, "Invalid key parameter");
  }

  const ext = key.toLowerCase().split(".").pop();

  // Only allow preview for .txt and .md files
  if (ext !== "txt" && ext !== "md") {
    throw new HttpError(400, "Preview is only supported for .txt and .md files");
  }

  const doc = getDocument(key);

  if (!doc) {
    throw new HttpError(404, "File not found");
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
});

// Recent files endpoint - returns recently updated .txt and .md files from database
appApi.get("/documents/recent", (req, res) => {
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
});

// Search API Routes
appApi.get("/search", (req, res) => {
  const query = (req.query.q as string) || "";
  const { limit, offset } = parsePagination(req.query as { limit?: string; offset?: string }, { defaultLimit: 20 });

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
});

appApi.post("/search/reindex", async (_req, res) => {
  const data = await fetchOrThrow(`${JOB_RUNNER_URL}/reindex`, {
    method: "POST",
  });
  res.json(data);
});

appApi.get("/search/reindex/status", async (_req, res) => {
  const data = await fetchOrThrow<{ running: boolean; syncing: boolean }>(`${JOB_RUNNER_URL}/status`);
  res.json(data);
});

appApi.post("/search/sync", async (_req, res) => {
  const data = await fetchOrThrow(`${JOB_RUNNER_URL}/sync`, {
    method: "POST",
  });
  res.json(data);
});

appApi.get("/search/stats", (_req, res) => {
  const stats = getStats();
  res.json(stats);
});

// Collections API Routes
appApi.get("/collections", (req, res) => {
  const { limit, offset } = parsePagination(req.query as { limit?: string; offset?: string });
  const { sortBy, sortOrder } = parseSortParams(req.query as { sortBy?: string; sortOrder?: string });
  const result = getCollections({ limit, offset, sortBy, sortOrder });
  res.json(result);
});

appApi.get("/collections/:collection", (req, res) => {
  const { collection } = req.params;
  const { limit, offset } = parsePagination(req.query as { limit?: string; offset?: string });
  const { sortBy, sortOrder } = parseSortParams(req.query as { sortBy?: string; sortOrder?: string });
  // Return grouped titles for this collection
  const result = getCollectionTitles(collection, { limit, offset, sortBy, sortOrder });
  res.json(result);
});

appApi.get("/collections/:collection/documents/:title", (req, res) => {
  const { collection, title: titleParam } = req.params;
  // Translate placeholder to null for querying documents with NULL title
  const title = titleParam === "__NO_TITLE_e4f7b2c9__" ? null : titleParam;
  const { limit, offset } = parsePagination(req.query as { limit?: string; offset?: string });
  const { sortBy, sortOrder } = parseSortParams(req.query as { sortBy?: string; sortOrder?: string });
  // Return documents for this specific title within the collection
  const result = getCollectionDocuments(collection, { limit, offset, title, sortBy, sortOrder });
  res.json(result);
});

app.use("/api/app", appApi);

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

// Global error handler middleware (4 params required for Express to recognize as error handler)
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  if (err instanceof Error) {
    console.error("Unhandled error:", err);
    res.status(500).json({ error: err.message });
    return;
  }
  console.error("Unknown error:", err);
  res.status(500).json({ error: "Internal server error" });
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
