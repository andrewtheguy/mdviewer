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
  collection: string | null;
  title: string | null;
  creationDate: number | null;
  creationDateISO: string | null;
  hasMetadata: boolean;
}

// Encode S3 key to safe ID (base64url)
export function keyToId(key: string): string {
  return Buffer.from(key, "utf-8").toString("base64url");
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
    content_preview TEXT NOT NULL,
    collection TEXT,
    title TEXT,
    creation_date INTEGER,
    creation_date_iso TEXT,
    has_metadata INTEGER DEFAULT 0
  );
`;

// Shared FTS5 table definition
const FTS_TABLE_DEFINITION = `
  CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
    name, content, path, key, collection, title,
    content='documents',
    content_rowid='rowid',
    tokenize='porter unicode61'
  );
`;

// Shared trigger definitions to keep FTS in sync with main table
const TRIGGER_DEFINITIONS = `
  CREATE TRIGGER IF NOT EXISTS documents_ai AFTER INSERT ON documents BEGIN
    INSERT INTO documents_fts(rowid, name, content, path, key, collection, title)
    VALUES (new.rowid, new.name, new.content, new.path, new.key, new.collection, new.title);
  END;

  CREATE TRIGGER IF NOT EXISTS documents_ad AFTER DELETE ON documents BEGIN
    INSERT INTO documents_fts(documents_fts, rowid, name, content, path, key, collection, title)
    VALUES ('delete', old.rowid, old.name, old.content, old.path, old.key, old.collection, old.title);
  END;

  CREATE TRIGGER IF NOT EXISTS documents_au AFTER UPDATE ON documents BEGIN
    INSERT INTO documents_fts(documents_fts, rowid, name, content, path, key, collection, title)
    VALUES ('delete', old.rowid, old.name, old.content, old.path, old.key, old.collection, old.title);
    INSERT INTO documents_fts(rowid, name, content, path, key, collection, title)
    VALUES (new.rowid, new.name, new.content, new.path, new.key, new.collection, new.title);
  END;
`;

let db: Database.Database | null = null;

function getDatabase(): Database.Database {
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

function closeDatabase(): void {
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
  // Create tables and triggers only if they don't exist (preserves data across restarts)
  database.exec(`
    ${DOCUMENTS_TABLE_DEFINITION}

    ${FTS_TABLE_DEFINITION}

    ${TRIGGER_DEFINITIONS}

    CREATE INDEX IF NOT EXISTS idx_documents_key ON documents(key);
    CREATE INDEX IF NOT EXISTS idx_documents_collection ON documents(collection);
    CREATE INDEX IF NOT EXISTS idx_documents_creation_date ON documents(creation_date DESC);
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
      d.collection,
      d.title,
      d.creation_date as creationDate,
      d.creation_date_iso as creationDateISO,
      d.has_metadata as hasMetadata,
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
    collection: string | null;
    title: string | null;
    creationDate: number | null;
    creationDateISO: string | null;
    hasMetadata: number;
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
    collection: row.collection,
    title: row.title,
    creationDate: row.creationDate,
    creationDateISO: row.creationDateISO,
    hasMetadata: row.hasMetadata === 1,
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

export function addDocuments(docs: S3FileDocument[]): void {
  const database = getDatabase();

  const stmt = database.prepare(`
    INSERT OR REPLACE INTO documents
      (id, key, name, extension, path, size, last_modified, last_modified_iso, content, content_preview,
       collection, title, creation_date, creation_date_iso, has_metadata)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        doc.contentPreview,
        doc.collection,
        doc.title,
        doc.creationDate,
        doc.creationDateISO,
        doc.hasMetadata ? 1 : 0
      );
    }
  });

  insertMany(docs);
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
      CREATE INDEX IF NOT EXISTS idx_documents_collection ON documents(collection);
      CREATE INDEX IF NOT EXISTS idx_documents_creation_date ON documents(creation_date DESC);
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

// List all documents with pagination (for /api/documents/list)
export function listDocuments(options: ListDocumentsOptions = {}): ListDocumentsResult {
  const database = getDatabase();

  // Get total count
  const countStmt = database.prepare("SELECT COUNT(*) as count FROM documents");
  const countResult = countStmt.get() as { count: number };
  const total = countResult.count;

  const limit = validatePaginationParam(options.limit, 100, MAX_LIMIT);
  const offset = validatePaginationParam(options.offset, 0, MAX_OFFSET);

  const stmt = database.prepare(`
    SELECT key, size, last_modified_iso as lastModified
    FROM documents
    ORDER BY key ASC
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
  collection: string | null;
  title: string | null;
  creationDate: number | null;
  creationDateISO: string | null;
}

// Get recent documents with pagination/filtering (for /api/documents/recent)
export function getRecentDocuments(options: RecentDocumentsOptions = {}): {
  files: RecentDocument[];
  totalFiles: number;
} {
  const database = getDatabase();
  const limit = validatePaginationParam(options.limit, 50, MAX_LIMIT);
  const offset = validatePaginationParam(options.offset, 0, MAX_OFFSET);
  const typeFilter = options.type ?? "all";

  // Build WHERE clause based on type filter (parameterized)
  let whereClause = "";
  const filterParams: string[] = [];
  if (typeFilter === "txt" || typeFilter === "md") {
    whereClause = "WHERE extension = ?";
    filterParams.push(typeFilter);
  }

  // Get total count
  const countStmt = database.prepare(`SELECT COUNT(*) as count FROM documents ${whereClause}`);
  const countResult = countStmt.get(...filterParams) as { count: number };
  const totalFiles = countResult.count;

  // Get paginated results sorted by creation date (most recent first)
  const stmt = database.prepare(`
    SELECT key, name, path, size,
           last_modified as lastModified, last_modified_iso as lastModifiedISO,
           collection, title, creation_date as creationDate, creation_date_iso as creationDateISO
    FROM documents
    ${whereClause}
    ORDER BY creation_date DESC
    LIMIT ? OFFSET ?
  `);

  const rows = stmt.all(...filterParams, limit, offset) as Array<{
    key: string;
    name: string;
    path: string;
    size: number;
    lastModified: number | null;
    lastModifiedISO: string | null;
    collection: string | null;
    title: string | null;
    creationDate: number | null;
    creationDateISO: string | null;
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

// Get single document by key (for /api/documents/download and /api/documents/preview)
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

export interface DocumentMetadata {
  key: string;
  collection: string | null;
  title: string | null;
  creationDate: number | null;
  creationDateISO: string | null;
}

// Get document metadata by key (for preview API)
export function getDocumentMetadata(key: string): DocumentMetadata | null {
  const database = getDatabase();
  const stmt = database.prepare(`
    SELECT key, collection, title, creation_date as creationDate, creation_date_iso as creationDateISO
    FROM documents
    WHERE key = ?
  `);
  const result = stmt.get(key) as DocumentMetadata | undefined;
  return result ?? null;
}

export interface BrowseFolderOptions {
  path: string;
  limit?: number;
  offset?: number;
}

export interface BrowseFolderResult {
  folders: string[];
  files: Array<{ key: string; size: number; lastModified: string | null }>;
  totalFolders: number;
  totalFiles: number;
}

// Escape LIKE wildcards for literal matching
function escapeLikePattern(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

// Browse a folder - returns subfolders and paginated files at the given path
export function browseFolder(options: BrowseFolderOptions): BrowseFolderResult {
  const database = getDatabase();
  const { path } = options;
  const limit = validatePaginationParam(options.limit, 50, MAX_LIMIT);
  const offset = validatePaginationParam(options.offset, 0, MAX_OFFSET);

  // Build prefix for path matching
  // If path is empty (root), we match all keys
  // If path is "foo", we match "foo/..." but not "foobar/..."
  const prefix = path ? path + "/" : "";
  const prefixLen = prefix.length;

  // Escape LIKE wildcards in the prefix for literal matching
  const escapedPrefix = escapeLikePattern(prefix);

  // Query for files at this level: keys that match prefix but don't have another slash
  // i.e., key LIKE 'prefix%' AND key NOT LIKE 'prefix%/%'
  const filesCountStmt = database.prepare(`
    SELECT COUNT(*) as count
    FROM documents
    WHERE key LIKE ? ESCAPE '\\'
      AND key NOT LIKE ? ESCAPE '\\'
  `);
  const filesCountResult = filesCountStmt.get(
    escapedPrefix + "%",
    escapedPrefix + "%/_%"
  ) as { count: number };
  const totalFiles = filesCountResult.count;

  const filesStmt = database.prepare(`
    SELECT key, size, last_modified_iso as lastModified
    FROM documents
    WHERE key LIKE ? ESCAPE '\\'
      AND key NOT LIKE ? ESCAPE '\\'
    ORDER BY key ASC
    LIMIT ? OFFSET ?
  `);
  const files = filesStmt.all(
    escapedPrefix + "%",
    escapedPrefix + "%/_%",
    limit,
    offset
  ) as Array<{ key: string; size: number; lastModified: string | null }>;

  // Query for distinct folder names: extract first path segment after prefix
  // for keys that have at least one more slash after the prefix
  const foldersStmt = database.prepare(`
    SELECT DISTINCT substr(key, ? + 1, instr(substr(key, ? + 1), '/') - 1) as folder
    FROM documents
    WHERE key LIKE ? ESCAPE '\\'
      AND instr(substr(key, ? + 1), '/') > 0
    ORDER BY folder ASC
  `);
  const folderRows = foldersStmt.all(
    prefixLen,
    prefixLen,
    escapedPrefix + "%",
    prefixLen
  ) as Array<{ folder: string }>;
  const folders = folderRows.map(row => row.folder);
  const totalFolders = folders.length;

  return {
    folders,
    files,
    totalFolders,
    totalFiles,
  };
}

// Collection interfaces
export interface CollectionSummary {
  name: string;
  count: number;
  latestCreationDate: string | null;
}

export interface CollectionTranscript {
  key: string;
  name: string;
  title: string | null;
  creationDate: number | null;
  creationDateISO: string | null;
  size: number;
}

export interface CollectionTranscriptsResult {
  transcripts: CollectionTranscript[];
  collection: string;
  total: number;
}

export interface CollectionsResult {
  collections: CollectionSummary[];
  total: number;
}

// Get all collections with counts (with pagination)
export function getCollections(options: { limit?: number; offset?: number } = {}): CollectionsResult {
  const database = getDatabase();
  const limit = validatePaginationParam(options.limit, 50, MAX_LIMIT);
  const offset = validatePaginationParam(options.offset, 0, MAX_OFFSET);

  // Get total count of distinct collections
  const countStmt = database.prepare(`
    SELECT COUNT(DISTINCT collection) as count
    FROM documents
    WHERE collection IS NOT NULL
  `);
  const countResult = countStmt.get() as { count: number };
  const total = countResult.count;

  const stmt = database.prepare(`
    SELECT
      collection as name,
      COUNT(*) as count,
      MAX(creation_date_iso) as latestCreationDate
    FROM documents
    WHERE collection IS NOT NULL
    GROUP BY collection
    ORDER BY MAX(creation_date) DESC
    LIMIT ? OFFSET ?
  `);

  const rows = stmt.all(limit, offset) as Array<{
    name: string;
    count: number;
    latestCreationDate: string | null;
  }>;

  return { collections: rows, total };
}

// Collection title interfaces
export interface CollectionTitle {
  title: string;  // "Untitled" for null titles
  count: number;
  latestCreationDate: string | null;
}

export interface CollectionTitlesResult {
  titles: CollectionTitle[];
  collection: string;
  total: number;
}

// Get titles grouped within a collection
export function getCollectionTitles(
  collection: string,
  options: { limit?: number; offset?: number } = {}
): CollectionTitlesResult {
  const database = getDatabase();
  const limit = validatePaginationParam(options.limit, 50, MAX_LIMIT);
  const offset = validatePaginationParam(options.offset, 0, MAX_OFFSET);

  // Get total count of distinct titles in this collection
  const countStmt = database.prepare(`
    SELECT COUNT(DISTINCT COALESCE(title, '__NO_TITLE_e4f7b2c9__')) as count
    FROM documents
    WHERE collection = ?
  `);
  const countResult = countStmt.get(collection) as { count: number };
  const total = countResult.count;

  // Get paginated titles sorted by latest creation date DESC
  const stmt = database.prepare(`
    SELECT
      COALESCE(title, '__NO_TITLE_e4f7b2c9__') as title,
      COUNT(*) as count,
      MAX(creation_date_iso) as latestCreationDate
    FROM documents
    WHERE collection = ?
    GROUP BY COALESCE(title, '__NO_TITLE_e4f7b2c9__')
    ORDER BY MAX(creation_date) DESC
    LIMIT ? OFFSET ?
  `);

  const titles = stmt.all(collection, limit, offset) as CollectionTitle[];

  return {
    titles,
    collection,
    total,
  };
}

// Get transcripts in a collection (optionally filtered by title)
// When title is null, filters for documents with NULL title
// When title is a string, filters for exact title match
// When title is undefined, no title filter is applied
export function getCollectionTranscripts(
  collection: string,
  options: { limit?: number; offset?: number; title?: string | null } = {}
): CollectionTranscriptsResult {
  const database = getDatabase();
  const limit = validatePaginationParam(options.limit, 50, MAX_LIMIT);
  const offset = validatePaginationParam(options.offset, 0, MAX_OFFSET);
  const titleFilter = options.title;

  // Build WHERE clause based on title filter
  let whereClause = "WHERE collection = ?";
  const countParams: (string | null)[] = [collection];
  const selectParams: (string | null | number)[] = [collection];

  if (titleFilter === null) {
    // Filter by NULL title
    whereClause += " AND title IS NULL";
  } else if (titleFilter !== undefined) {
    // Filter by specific title (exact match)
    whereClause += " AND title = ?";
    countParams.push(titleFilter);
    selectParams.push(titleFilter);
  }

  // Get total count for this collection (with optional title filter)
  const countStmt = database.prepare(`
    SELECT COUNT(*) as count
    FROM documents
    ${whereClause}
  `);
  const countResult = countStmt.get(...countParams) as { count: number };
  const total = countResult.count;

  // Get paginated transcripts sorted by creation date DESC
  const stmt = database.prepare(`
    SELECT key, name, title, creation_date as creationDate, creation_date_iso as creationDateISO, size
    FROM documents
    ${whereClause}
    ORDER BY creation_date DESC
    LIMIT ? OFFSET ?
  `);

  selectParams.push(limit, offset);
  const transcripts = stmt.all(...selectParams) as CollectionTranscript[];

  return {
    transcripts,
    collection,
    total,
  };
}
