import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

// Re-export the document interface for compatibility
export interface S3FileDocument {
  id: string;
  key: string;
  name: string;
  extension: string;
  path: string;
  size: number;
  lastModified: number;
  lastModifiedISO: string;
  content: string;
  contentPreview: string;
}

// Encode S3 key to safe ID (base64url)
export function keyToId(key: string): string {
  return Buffer.from(key, "utf-8").toString("base64url");
}

// Decode ID back to S3 key
export function idToKey(id: string): string {
  return Buffer.from(id, "base64url").toString("utf-8");
}

const DB_PATH = process.env.SQLITE_DB_PATH || "./data/search.sqlite";

// Shared documents table definition
const DOCUMENTS_TABLE_DEFINITION = `
  CREATE TABLE IF NOT EXISTS documents (
    rowid INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    key TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    extension TEXT NOT NULL,
    path TEXT NOT NULL,
    size INTEGER NOT NULL,
    last_modified INTEGER NOT NULL,
    last_modified_iso TEXT NOT NULL,
    content TEXT NOT NULL,
    content_preview TEXT NOT NULL
  );
`;

// Shared FTS5 table definition
const FTS_TABLE_DEFINITION = `
  CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
    name, content, path, key,
    content='documents',
    content_rowid='rowid',
    tokenize='porter unicode61'
  );
`;

// Shared trigger definitions to keep FTS in sync with main table
const TRIGGER_DEFINITIONS = `
  CREATE TRIGGER IF NOT EXISTS documents_ai AFTER INSERT ON documents BEGIN
    INSERT INTO documents_fts(rowid, name, content, path, key)
    VALUES (new.rowid, new.name, new.content, new.path, new.key);
  END;

  CREATE TRIGGER IF NOT EXISTS documents_ad AFTER DELETE ON documents BEGIN
    INSERT INTO documents_fts(documents_fts, rowid, name, content, path, key)
    VALUES ('delete', old.rowid, old.name, old.content, old.path, old.key);
  END;

  CREATE TRIGGER IF NOT EXISTS documents_au AFTER UPDATE ON documents BEGIN
    INSERT INTO documents_fts(documents_fts, rowid, name, content, path, key)
    VALUES ('delete', old.rowid, old.name, old.content, old.path, old.key);
    INSERT INTO documents_fts(rowid, name, content, path, key)
    VALUES (new.rowid, new.name, new.content, new.path, new.key);
  END;
`;

let db: Database.Database | null = null;

export function getDatabase(): Database.Database {
  if (db) {
    return db;
  }

  // Ensure data directory exists
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("cache_size = -64000"); // 64MB cache

  initializeSchema(db);

  return db;
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}

// Register exit handlers once
let exitHandlersRegistered = false;

function registerExitHandlers(): void {
  if (exitHandlersRegistered) return;
  exitHandlersRegistered = true;

  process.on("exit", () => {
    try {
      closeDatabase();
    } catch (error) {
      console.error("Error closing database on exit:", error);
    }
  });

  process.on("SIGINT", () => {
    let exitCode = 0;
    try {
      closeDatabase();
    } catch (error) {
      console.error("Error closing database on SIGINT:", error);
      exitCode = 1;
    } finally {
      process.exit(exitCode);
    }
  });

  process.on("SIGTERM", () => {
    let exitCode = 0;
    try {
      closeDatabase();
    } catch (error) {
      console.error("Error closing database on SIGTERM:", error);
      exitCode = 1;
    } finally {
      process.exit(exitCode);
    }
  });
}

// Register handlers on module load
registerExitHandlers();

function initializeSchema(database: Database.Database): void {
  database.exec(`
    ${DOCUMENTS_TABLE_DEFINITION}

    ${FTS_TABLE_DEFINITION}

    ${TRIGGER_DEFINITIONS}

    -- Index for faster lookups by key
    CREATE INDEX IF NOT EXISTS idx_documents_key ON documents(key);
  `);
}

// Prepare FTS5 query - escape special characters and add prefix matching
function prepareFtsQuery(query: string): string {
  const terms = query.trim().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return "";

  return terms
    .map((term) => {
      // Escape double quotes
      const escaped = term.replace(/"/g, '""');
      // Use prefix matching with *
      return `"${escaped}"*`;
    })
    .join(" ");
}

export interface SearchResult {
  hits: Array<
    S3FileDocument & {
      _formatted: {
        name: string;
        content: string;
      };
    }
  >;
  query: string;
  totalHits: number;
  processingTimeMs: number;
}

export interface SearchOptions {
  limit?: number;
  offset?: number;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const MAX_OFFSET = 10000;

function validatePaginationParam(value: number | undefined, defaultValue: number, max?: number): number {
  if (value === undefined || value === null) return defaultValue;
  const num = Number(value);
  if (!Number.isFinite(num) || !Number.isInteger(num) || num < 0) return defaultValue;
  if (max !== undefined && num > max) return max;
  return num;
}

export function search(query: string, options: SearchOptions = {}): SearchResult {
  const startTime = performance.now();
  const database = getDatabase();

  const limit = validatePaginationParam(options.limit, DEFAULT_LIMIT, MAX_LIMIT);
  const offset = validatePaginationParam(options.offset, 0, MAX_OFFSET);

  const ftsQuery = prepareFtsQuery(query);
  if (!ftsQuery) {
    return {
      hits: [],
      query,
      totalHits: 0,
      processingTimeMs: Math.round(performance.now() - startTime),
    };
  }

  // Count total matches
  const countStmt = database.prepare(`
    SELECT COUNT(*) as count
    FROM documents_fts
    WHERE documents_fts MATCH ?
  `);
  const countResult = countStmt.get(ftsQuery) as { count: number };
  const totalHits = countResult.count;

  // Get paginated results with highlighting
  const searchStmt = database.prepare(`
    SELECT
      d.id,
      d.key,
      d.name,
      d.extension,
      d.path,
      d.size,
      d.last_modified as lastModified,
      d.last_modified_iso as lastModifiedISO,
      d.content,
      d.content_preview as contentPreview,
      highlight(documents_fts, 0, '<mark>', '</mark>') as highlighted_name,
      snippet(documents_fts, 1, '<mark>', '</mark>', '...', 32) as highlighted_content,
      bm25(documents_fts) as rank
    FROM documents_fts
    JOIN documents d ON documents_fts.rowid = d.rowid
    WHERE documents_fts MATCH ?
    ORDER BY rank
    LIMIT ? OFFSET ?
  `);

  const rows = searchStmt.all(ftsQuery, limit, offset) as Array<{
    id: string;
    key: string;
    name: string;
    extension: string;
    path: string;
    size: number;
    lastModified: number;
    lastModifiedISO: string;
    content: string;
    contentPreview: string;
    highlighted_name: string;
    highlighted_content: string;
    rank: number;
  }>;

  const hits = rows.map((row) => ({
    id: row.id,
    key: row.key,
    name: row.name,
    extension: row.extension,
    path: row.path,
    size: row.size,
    lastModified: row.lastModified,
    lastModifiedISO: row.lastModifiedISO,
    content: row.content,
    contentPreview: row.contentPreview,
    _formatted: {
      name: row.highlighted_name,
      content: row.highlighted_content,
    },
  }));

  return {
    hits,
    query,
    totalHits,
    processingTimeMs: Math.round(performance.now() - startTime),
  };
}

export function addDocument(doc: S3FileDocument): void {
  const database = getDatabase();

  const stmt = database.prepare(`
    INSERT OR REPLACE INTO documents
      (id, key, name, extension, path, size, last_modified, last_modified_iso, content, content_preview)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    doc.id,
    doc.key,
    doc.name,
    doc.extension,
    doc.path,
    doc.size,
    doc.lastModified,
    doc.lastModifiedISO,
    doc.content,
    doc.contentPreview
  );
}

export function addDocuments(docs: S3FileDocument[]): void {
  const database = getDatabase();

  const stmt = database.prepare(`
    INSERT OR REPLACE INTO documents
      (id, key, name, extension, path, size, last_modified, last_modified_iso, content, content_preview)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertMany = database.transaction((documents: S3FileDocument[]) => {
    for (const doc of documents) {
      stmt.run(
        doc.id,
        doc.key,
        doc.name,
        doc.extension,
        doc.path,
        doc.size,
        doc.lastModified,
        doc.lastModifiedISO,
        doc.content,
        doc.contentPreview
      );
    }
  });

  insertMany(docs);
}

export function deleteDocument(key: string): void {
  const database = getDatabase();
  const stmt = database.prepare("DELETE FROM documents WHERE key = ?");
  stmt.run(key);
}

export function deleteAllDocuments(): void {
  const database = getDatabase();

  // Drop triggers, FTS table, and truncate documents table to avoid
  // firing the delete trigger for each row (much faster for large datasets).
  // Wrapped in a transaction to ensure atomicity.
  const rebuildFts = database.transaction(() => {
    database.exec(`
      DROP TRIGGER IF EXISTS documents_ai;
      DROP TRIGGER IF EXISTS documents_ad;
      DROP TRIGGER IF EXISTS documents_au;
      DROP TABLE IF EXISTS documents_fts;
      DROP TABLE IF EXISTS documents;

      ${DOCUMENTS_TABLE_DEFINITION}

      ${FTS_TABLE_DEFINITION}

      ${TRIGGER_DEFINITIONS}

      CREATE INDEX IF NOT EXISTS idx_documents_key ON documents(key);
    `);
  });

  rebuildFts();
}

export interface IndexStats {
  numberOfDocuments: number;
  isIndexing: boolean;
}

export function getStats(): IndexStats {
  const database = getDatabase();
  const stmt = database.prepare("SELECT COUNT(*) as count FROM documents");
  const result = stmt.get() as { count: number };

  return {
    numberOfDocuments: result.count,
    isIndexing: false, // SQLite is synchronous, no background indexing
  };
}

export interface ListDocumentsOptions {
  limit?: number;
  offset?: number;
}

export interface ListDocumentsResult {
  objects: Array<{ key: string; size: number; lastModified: string | null }>;
  total: number;
}

// List all documents with pagination (for /api/s3/list)
export function listDocuments(options: ListDocumentsOptions = {}): ListDocumentsResult {
  const database = getDatabase();
  const limit = validatePaginationParam(options.limit, 100, MAX_LIMIT);
  const offset = validatePaginationParam(options.offset, 0, MAX_OFFSET);

  // Get total count
  const countStmt = database.prepare("SELECT COUNT(*) as count FROM documents");
  const countResult = countStmt.get() as { count: number };
  const total = countResult.count;

  // Get paginated results
  const stmt = database.prepare(`
    SELECT key, size, last_modified_iso as lastModified
    FROM documents
    ORDER BY last_modified DESC
    LIMIT ? OFFSET ?
  `);
  const objects = stmt.all(limit, offset) as Array<{ key: string; size: number; lastModified: string | null }>;

  return { objects, total };
}

export interface RecentDocumentsOptions {
  limit?: number;
  offset?: number;
  type?: "all" | "txt" | "md";
}

export interface RecentDocument {
  key: string;
  name: string;
  path: string;
  size: number;
  lastModified: number | null;
  lastModifiedISO: string | null;
}

// Get recent documents with pagination/filtering (for /api/s3/recent)
export function getRecentDocuments(options: RecentDocumentsOptions = {}): {
  files: RecentDocument[];
  totalFiles: number;
} {
  const database = getDatabase();
  const limit = validatePaginationParam(options.limit, 50, MAX_LIMIT);
  const offset = validatePaginationParam(options.offset, 0, MAX_OFFSET);
  const typeFilter = options.type ?? "all";

  // Build WHERE clause based on type filter
  let whereClause = "";
  if (typeFilter === "txt") {
    whereClause = "WHERE extension = 'txt'";
  } else if (typeFilter === "md") {
    whereClause = "WHERE extension = 'md'";
  }

  // Get total count
  const countStmt = database.prepare(`SELECT COUNT(*) as count FROM documents ${whereClause}`);
  const countResult = countStmt.get() as { count: number };
  const totalFiles = countResult.count;

  // Get paginated results sorted by most recent first
  const stmt = database.prepare(`
    SELECT key, name, path, size, last_modified as lastModified, last_modified_iso as lastModifiedISO
    FROM documents
    ${whereClause}
    ORDER BY last_modified DESC
    LIMIT ? OFFSET ?
  `);

  const rows = stmt.all(limit, offset) as Array<{
    key: string;
    name: string;
    path: string;
    size: number;
    lastModified: number | null;
    lastModifiedISO: string | null;
  }>;

  return {
    files: rows,
    totalFiles,
  };
}

export interface DocumentRecord {
  key: string;
  name: string;
  extension: string;
  content: string;
  size: number;
}

// Get single document by key (for /api/s3/download and /api/s3/preview)
export function getDocument(key: string): DocumentRecord | null {
  const database = getDatabase();
  const stmt = database.prepare(`
    SELECT key, name, extension, content, size
    FROM documents
    WHERE key = ?
  `);
  const result = stmt.get(key) as DocumentRecord | undefined;
  return result ?? null;
}
