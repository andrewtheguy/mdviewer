import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { s3 } from "./s3";

// Schema version - increment when schema or indexes change
export const SCHEMA_VERSION = 2;

// Re-export the document interface for compatibility
export interface S3FileDocument {
  id: string;
  key: string;
  name: string;
  extension: string;
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
const S3_INDEX_PREFIX = process.env.S3_INDEX_PREFIX || "";

// Shared documents table definition
const DOCUMENTS_TABLE_DEFINITION = `
  CREATE TABLE IF NOT EXISTS documents (
    rowid INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    key TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    extension TEXT NOT NULL,
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
    name, content, collection, title,
    content='documents',
    content_rowid='rowid',
    tokenize='porter unicode61'
  );
`;

// Schema version table - preserved across reindexes
const SCHEMA_VERSION_TABLE = `
  CREATE TABLE IF NOT EXISTS schema_version (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    version INTEGER NOT NULL
  );
`;

// Shared trigger definitions to keep FTS in sync with main table
const TRIGGER_DEFINITIONS = `
  CREATE TRIGGER IF NOT EXISTS documents_ai AFTER INSERT ON documents BEGIN
    INSERT INTO documents_fts(rowid, name, content, collection, title)
    VALUES (new.rowid, new.name, new.content, new.collection, new.title);
  END;

  CREATE TRIGGER IF NOT EXISTS documents_ad AFTER DELETE ON documents BEGIN
    INSERT INTO documents_fts(documents_fts, rowid, name, content, collection, title)
    VALUES ('delete', old.rowid, old.name, old.content, old.collection, old.title);
  END;

  CREATE TRIGGER IF NOT EXISTS documents_au AFTER UPDATE ON documents BEGIN
    INSERT INTO documents_fts(documents_fts, rowid, name, content, collection, title)
    VALUES ('delete', old.rowid, old.name, old.content, old.collection, old.title);
    INSERT INTO documents_fts(rowid, name, content, collection, title)
    VALUES (new.rowid, new.name, new.content, new.collection, new.title);
  END;
`;

// Index definitions
const INDEX_DEFINITIONS = `
  CREATE INDEX IF NOT EXISTS idx_documents_key ON documents(key);
  CREATE INDEX IF NOT EXISTS idx_documents_creation_date ON documents(creation_date DESC);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_collection_title_name ON documents(collection, title, name);
  CREATE INDEX IF NOT EXISTS idx_documents_collection_creation_date ON documents(collection, creation_date DESC);
  CREATE INDEX IF NOT EXISTS idx_documents_extension_creation_date ON documents(extension, creation_date DESC);
`;

// Combined schema DDL (used by both initializeSchema and clearDocuments)
const SCHEMA_DDL = `
  ${DOCUMENTS_TABLE_DEFINITION}
  ${FTS_TABLE_DEFINITION}
  ${TRIGGER_DEFINITIONS}
  ${INDEX_DEFINITIONS}
`;

let db: Database.Database | null = null;

// Generate a sortable key for natural sorting
// Pads numeric portions with zeros so lexicographic sort works correctly
// e.g., "file2" -> "file00000002", "file10" -> "file00000010"
function naturalSortKey(str: string): string {
  if (str == null) return "";
  return str.replace(/\d+/g, (match) => match.padStart(10, "0")).toLowerCase();
}

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

  // Register natural sort key function for proper alphanumeric ordering
  // e.g., "file2" comes before "file10"
  db.function("natural_sort_key", { deterministic: true }, (value: unknown) => {
    return naturalSortKey(value == null ? "" : String(value));
  });

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
  // Create schema_version table first (preserved across reindexes)
  database.exec(SCHEMA_VERSION_TABLE);

  // Create tables, triggers, and indexes (preserves data across restarts)
  database.exec(SCHEMA_DDL);
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

// Sorting types
export type SortField = "name" | "date";
export type SortOrder = "asc" | "desc";

export interface SortOptions {
  sortBy?: SortField;
  sortOrder?: SortOrder;
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
      (id, key, name, extension, size, last_modified, last_modified_iso, content, content_preview,
       collection, title, creation_date, creation_date_iso, has_metadata)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertMany = database.transaction((documents: S3FileDocument[]) => {
    for (const doc of documents) {
      stmt.run(
        doc.id,
        doc.key,
        doc.name,
        doc.extension,
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

// Clear all documents (private - used by runReindex)
// Does NOT drop schema_version table
function clearDocuments(): void {
  const database = getDatabase();

  // Drop triggers, FTS table, and documents table to avoid firing the delete
  // trigger for each row (much faster for large datasets), then recreate.
  // Wrapped in a transaction to ensure atomicity.
  const rebuildSchema = database.transaction(() => {
    database.exec(`
      DROP TRIGGER IF EXISTS documents_ai;
      DROP TRIGGER IF EXISTS documents_ad;
      DROP TRIGGER IF EXISTS documents_au;
      DROP TABLE IF EXISTS documents_fts;
      DROP TABLE IF EXISTS documents;
    `);
    database.exec(SCHEMA_DDL);
  });

  rebuildSchema();
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
    SELECT key, name, size,
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

// Get all collections (with pagination and sorting)
export function getCollections(options: { limit?: number; offset?: number; sortBy?: SortField; sortOrder?: SortOrder } = {}): CollectionsResult {
  const database = getDatabase();
  const limit = validatePaginationParam(options.limit, 50, MAX_LIMIT);
  const offset = validatePaginationParam(options.offset, 0, MAX_OFFSET);
  const sortBy = options.sortBy ?? "date";
  const sortOrder = options.sortOrder ?? "desc";

  // Get total count of distinct collections for pagination
  const countStmt = database.prepare(`
    SELECT COUNT(DISTINCT collection) as count
    FROM documents
    WHERE collection IS NOT NULL
  `);
  const countResult = countStmt.get() as { count: number };
  const total = countResult.count;

  // Build ORDER BY clause based on sort options
  // Use natural_sort_key() for name sorting to get proper alphanumeric order
  const orderByClause = sortBy === "name"
    ? `natural_sort_key(collection) ${sortOrder === "asc" ? "ASC" : "DESC"}`
    : `MAX(creation_date) ${sortOrder === "asc" ? "ASC" : "DESC"}`;

  const stmt = database.prepare(`
    SELECT
      collection as name,
      MAX(creation_date_iso) as latestCreationDate
    FROM documents
    WHERE collection IS NOT NULL
    GROUP BY collection
    ORDER BY ${orderByClause}
    LIMIT ? OFFSET ?
  `);

  const rows = stmt.all(limit, offset) as CollectionSummary[];

  return { collections: rows, total };
}

// Collection title interfaces
export interface CollectionTitle {
  title: string;  // "Untitled" for null titles
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
  options: { limit?: number; offset?: number; sortBy?: SortField; sortOrder?: SortOrder } = {}
): CollectionTitlesResult {
  const database = getDatabase();
  const limit = validatePaginationParam(options.limit, 50, MAX_LIMIT);
  const offset = validatePaginationParam(options.offset, 0, MAX_OFFSET);
  const sortBy = options.sortBy ?? "date";
  const sortOrder = options.sortOrder ?? "desc";

  // Get total count of distinct titles in this collection for pagination
  const countStmt = database.prepare(`
    SELECT COUNT(DISTINCT COALESCE(title, '__NO_TITLE_e4f7b2c9__')) as count
    FROM documents
    WHERE collection = ?
  `);
  const countResult = countStmt.get(collection) as { count: number };
  const total = countResult.count;

  // Build ORDER BY clause based on sort options
  // Use natural_sort_key() for name sorting to get proper alphanumeric order
  const orderByClause = sortBy === "name"
    ? `natural_sort_key(COALESCE(title, '__NO_TITLE_e4f7b2c9__')) ${sortOrder === "asc" ? "ASC" : "DESC"}`
    : `MAX(creation_date) ${sortOrder === "asc" ? "ASC" : "DESC"}`;

  // Get paginated titles sorted by specified field
  const stmt = database.prepare(`
    SELECT
      COALESCE(title, '__NO_TITLE_e4f7b2c9__') as title,
      MAX(creation_date_iso) as latestCreationDate
    FROM documents
    WHERE collection = ?
    GROUP BY COALESCE(title, '__NO_TITLE_e4f7b2c9__')
    ORDER BY ${orderByClause}
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
  options: { limit?: number; offset?: number; title?: string | null; sortBy?: SortField; sortOrder?: SortOrder } = {}
): CollectionTranscriptsResult {
  const database = getDatabase();
  const limit = validatePaginationParam(options.limit, 50, MAX_LIMIT);
  const offset = validatePaginationParam(options.offset, 0, MAX_OFFSET);
  const titleFilter = options.title;
  const sortBy = options.sortBy ?? "date";
  const sortOrder = options.sortOrder ?? "desc";

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

  // Build ORDER BY clause based on sort options
  // Use natural_sort_key() for name sorting to get proper alphanumeric order
  const orderByClause = sortBy === "name"
    ? `natural_sort_key(name) ${sortOrder === "asc" ? "ASC" : "DESC"}`
    : `creation_date ${sortOrder === "asc" ? "ASC" : "DESC"}`;

  // Get paginated transcripts sorted by specified field
  const stmt = database.prepare(`
    SELECT key, name, title, creation_date as creationDate, creation_date_iso as creationDateISO, size
    FROM documents
    ${whereClause}
    ORDER BY ${orderByClause}
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

// Schema version functions
export function getSchemaVersion(): number | null {
  const database = getDatabase();
  const stmt = database.prepare("SELECT version FROM schema_version WHERE id = 1");
  const result = stmt.get() as { version: number } | undefined;
  return result?.version ?? null;
}

export function setSchemaVersion(version: number): void {
  const database = getDatabase();
  database.prepare(`
    INSERT INTO schema_version (id, version) VALUES (1, ?)
    ON CONFLICT(id) DO UPDATE SET version = excluded.version
  `).run(version);
}

// Reindex status tracking
export interface ReindexStatus {
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

const reindexStatus: ReindexStatus = {
  running: false,
  progress: { current: 0, total: 0 },
  lastResult: null,
};

export function getReindexStatus(): ReindexStatus {
  return structuredClone(reindexStatus);
}

// Metadata interface for folder metadata.json files
interface FolderMetadata {
  creation_date: string;  // ISO 8601
  version: number;
  type: string;           // "transcribefoldermetadata"
  collection: string;
  title: string;
}

const INDEXABLE_EXTENSIONS = ["txt", "md"];
const CONTENT_PREVIEW_LENGTH = 500;
const INDEX_BATCH_SIZE = 100;
const S3_FETCH_TIMEOUT_MS = 30000; // 30 seconds per file

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
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timeout after ${ms}ms: ${label}`)), ms);
    }),
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
      console.warn(`[Reindex] Invalid metadata type at ${metadataKey}: expected "transcribefoldermetadata", got "${metadata.type}"`);
      return null;
    }

    // Validate required fields
    if (typeof metadata.collection !== "string" || typeof metadata.title !== "string") {
      console.warn(`[Reindex] Missing collection or title in metadata at ${metadataKey}`);
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
    // Distinguish JSON parse errors from fetch errors
    if (error instanceof SyntaxError) {
      console.warn(`[Reindex] Failed to parse metadata JSON at ${metadataKey}:`, error.message);
    } else {
      console.warn(`[Reindex] Failed to fetch metadata at ${metadataKey}:`, error);
    }
    return null;
  }
}

export async function runReindex(): Promise<void> {
  const result = {
    total: 0,
    indexed: 0,
    skipped: 0,
    errors: 0,
  };

  try {
    console.log("[Reindex] Deleting all documents...");
    clearDocuments();

    console.log("[Reindex] Listing S3 files...");
    const listResult = await s3.list();
    const objects = listResult.contents || [];

    result.total = objects.length;

    // Filter by extension and optional S3 prefix
    const indexableObjects = objects
      .filter((obj) => obj.key && isIndexable(obj.key))
      .filter((obj) => !S3_INDEX_PREFIX || obj.key!.startsWith(S3_INDEX_PREFIX));
    result.skipped = objects.length - indexableObjects.length;

    if (S3_INDEX_PREFIX) {
      console.log(`[Reindex] Filtering by prefix: "${S3_INDEX_PREFIX}"`);
    }
    reindexStatus.progress.total = indexableObjects.length;
    console.log(
      `[Reindex] Found ${objects.length} total files, ${indexableObjects.length} indexable`
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

    console.log(`[Reindex] Found ${filesByFolder.size} unique folders`);

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
    console.log(`[Reindex] Found metadata.json in ${foldersWithMetadata}/${filesByFolder.size} folders`);

    let pendingDocuments: S3FileDocument[] = [];
    let processedCount = 0;

    for (let i = 0; i < indexableObjects.length; i++) {
      const obj = indexableObjects[i]!;
      const key = obj.key!;
      const folderPath = getPath(key);

      // Get metadata for this file's folder - skip files without metadata
      const metadata = folderMetadataCache.get(folderPath) ?? null;
      if (metadata === null) {
        result.skipped++;
        processedCount++;
        reindexStatus.progress.current = processedCount;
        continue;
      }

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

        // Determine creation date - use metadata if available and valid, otherwise S3 lastModified
        let creationDate: Date;
        let creationDateISO: string;
        if (metadata?.creation_date) {
          const parsed = new Date(metadata.creation_date);
          if (!isNaN(parsed.getTime())) {
            creationDate = parsed;
            creationDateISO = metadata.creation_date;
          } else {
            console.warn(`[Reindex] Invalid metadata.creation_date "${metadata.creation_date}" for ${key}, using lastModified (${lastModified.toISOString()}) as fallback`);
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
          size: obj.size ?? 0,
          lastModified: lastModified.getTime(),
          lastModifiedISO: lastModified.toISOString(),
          content,
          contentPreview,
          collection: metadata.collection,
          title: metadata.title,
          creationDate: creationDate.getTime(),
          creationDateISO,
          hasMetadata: true,
        });
      } catch (err) {
        console.error(`[Reindex] Failed to fetch "${key}":`, err);
        result.errors++;
      }

      if (pendingDocuments.length >= INDEX_BATCH_SIZE) {
        try {
          addDocuments(pendingDocuments);
          result.indexed += pendingDocuments.length;
        } catch (err) {
          console.error("[Reindex] Failed to add batch to SQLite:", err);
          result.errors += pendingDocuments.length;
        }
        pendingDocuments = [];
      }

      processedCount++;
      reindexStatus.progress.current = processedCount;
      if (processedCount % 100 === 0 || processedCount === indexableObjects.length) {
        console.log(
          `[Reindex] Processed ${processedCount}/${indexableObjects.length} files (indexed: ${result.indexed})...`
        );
      }
    }

    if (pendingDocuments.length > 0) {
      console.log(`[Reindex] Adding final ${pendingDocuments.length} documents...`);
      try {
        addDocuments(pendingDocuments);
        result.indexed += pendingDocuments.length;
      } catch (err) {
        console.error("[Reindex] Failed to add final batch to SQLite:", err);
        result.errors += pendingDocuments.length;
      }
    }

    // Update schema version on successful reindex
    setSchemaVersion(SCHEMA_VERSION);

    console.log("[Reindex] Reindex completed successfully!", result);
    reindexStatus.lastResult = {
      success: true,
      ...result,
      completedAt: new Date().toISOString(),
    };
  } catch (error) {
    console.error("[Reindex] Reindex error:", error);
    reindexStatus.lastResult = {
      success: false,
      ...result,
      completedAt: new Date().toISOString(),
    };
  }
}

// Start a reindex job (returns immediately, runs in background)
export function startReindex(): { success: boolean; message: string } {
  if (reindexStatus.running) {
    return { success: false, message: "Reindex already in progress" };
  }

  reindexStatus.running = true;
  reindexStatus.progress = { current: 0, total: 0 };

  // Run reindex in background (don't await)
  runReindex().finally(() => {
    reindexStatus.running = false;
    reindexStatus.progress = { current: 0, total: 0 };
  });

  return { success: true, message: "Reindex started" };
}
