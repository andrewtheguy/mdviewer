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
    closeDatabase();
  });

  process.on("SIGINT", () => {
    closeDatabase();
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    closeDatabase();
    process.exit(0);
  });
}

// Register handlers on module load
registerExitHandlers();

function initializeSchema(database: Database.Database): void {
  database.exec(`
    -- Main documents table
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

    -- FTS5 virtual table (external content)
    CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
      name, content, path, key,
      content='documents',
      content_rowid='rowid',
      tokenize='porter unicode61'
    );

    -- Triggers to keep FTS in sync with main table
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
  const offset = validatePaginationParam(options.offset, 0);

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
      DELETE FROM documents;

      -- Recreate FTS table
      CREATE VIRTUAL TABLE documents_fts USING fts5(
        name, content, path, key,
        content='documents',
        content_rowid='rowid',
        tokenize='porter unicode61'
      );

      -- Recreate triggers
      CREATE TRIGGER documents_ai AFTER INSERT ON documents BEGIN
        INSERT INTO documents_fts(rowid, name, content, path, key)
        VALUES (new.rowid, new.name, new.content, new.path, new.key);
      END;

      CREATE TRIGGER documents_ad AFTER DELETE ON documents BEGIN
        INSERT INTO documents_fts(documents_fts, rowid, name, content, path, key)
        VALUES ('delete', old.rowid, old.name, old.content, old.path, old.key);
      END;

      CREATE TRIGGER documents_au AFTER UPDATE ON documents BEGIN
        INSERT INTO documents_fts(documents_fts, rowid, name, content, path, key)
        VALUES ('delete', old.rowid, old.name, old.content, old.path, old.key);
        INSERT INTO documents_fts(rowid, name, content, path, key)
        VALUES (new.rowid, new.name, new.content, new.path, new.key);
      END;
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
