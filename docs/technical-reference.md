# Technical Reference

This document describes the database schema, reindex process, metadata format, and API endpoints for the Markdown Viewer application.

## Database Schema

The application uses SQLite with FTS5 (Full-Text Search). The database is stored at the path specified by `SQLITE_DB_PATH` environment variable (defaults to `./data/search.sqlite`).

### Tables

#### `documents`

The main table storing document metadata and content.

| Column | Type | Description |
|--------|------|-------------|
| `rowid` | INTEGER PRIMARY KEY | Auto-incrementing row ID |
| `id` | TEXT UNIQUE | Base64url-encoded S3 key |
| `key` | TEXT UNIQUE | Full S3 object key (path to file) |
| `name` | TEXT | File basename (filename only) |
| `extension` | TEXT | File extension (txt, md, etc.) |
| `path` | TEXT | Directory path (everything before filename) |
| `size` | INTEGER | File size in bytes |
| `last_modified` | INTEGER | Unix timestamp of last modification |
| `last_modified_iso` | TEXT | ISO 8601 datetime string |
| `content` | TEXT | Full file content |
| `content_preview` | TEXT | First 500 characters of content |
| `collection` | TEXT | Collection name from metadata (nullable) |
| `title` | TEXT | Title from metadata (nullable) |
| `creation_date` | INTEGER | Unix timestamp from metadata (nullable) |
| `creation_date_iso` | TEXT | ISO 8601 creation date (nullable) |
| `has_metadata` | INTEGER | Boolean flag (0/1) indicating if metadata.json was found |

#### `documents_fts`

FTS5 virtual table for full-text search, automatically synchronized with `documents` via triggers.

**Indexed columns:** `name`, `content`, `path`, `key`, `collection`, `title`

**Tokenizer:** Porter stemmer with unicode61 support

#### `schema_version`

Tracks schema version across reindexes.

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PRIMARY KEY | Always 1 (single row) |
| `version` | INTEGER | Current schema version |

### Indexes

- `idx_documents_key` - On `key` for fast lookups
- `idx_documents_creation_date` - On `creation_date` DESC for sorting recent items
- `idx_documents_collection_title` - On `(collection, title)`
- `idx_documents_collection_creation_date` - On `(collection, creation_date DESC)`
- `idx_documents_extension_creation_date` - On `(extension, creation_date DESC)`

### Triggers

The FTS table stays in sync with the documents table automatically via triggers:

- `documents_ai` (AFTER INSERT) - Syncs inserts to FTS table
- `documents_ad` (AFTER DELETE) - Syncs deletes from FTS table
- `documents_au` (AFTER UPDATE) - Syncs updates to FTS table

## Reindex Flow

The reindex process rebuilds the search index from S3 storage. It runs asynchronously via the job runner service.

### Triggering a Reindex

1. **Via API:** `POST /api/search/reindex` on the main server (port 3000)
2. **Direct:** `POST /reindex` on the job runner (port 3001)

### Reindex Steps

1. **Clear Database**
   - Drops triggers, FTS table, and documents table
   - Recreates all tables and indexes atomically
   - Preserves `schema_version` table

2. **List S3 Objects**
   - Fetches complete file listing from S3 bucket

3. **Filter Indexable Files**
   - Only `.txt` and `.md` files are processed

4. **Group by Folder**
   - Files are organized by their directory path

5. **Fetch Metadata (Parallel)**
   - For each unique folder, looks for `metadata.json`
   - Up to 10 concurrent metadata fetches
   - 30-second timeout per file
   - Results are cached to avoid redundant fetches

6. **Process Each File (Batched)**
   - Fetches full content from S3 (30-second timeout)
   - Extracts first 500 characters as preview
   - Merges with folder metadata if available
   - Processes in batches of 100 files

7. **Insert Documents**
   - Bulk inserts in batches of 100

8. **Update Schema Version**
   - Sets schema version to mark reindex complete

### Status Tracking

The reindex status can be checked via `GET /api/search/reindex/status`:

```json
{
  "running": true,
  "progress": {
    "current": 150,
    "total": 500
  },
  "lastResult": {
    "success": true,
    "totalFiles": 500,
    "indexedFiles": 480,
    "skippedFiles": 20,
    "errorCount": 0,
    "completedAt": "2024-01-15T10:30:00.000Z"
  }
}
```

## Metadata JSON Format

Each folder in S3 can contain a `metadata.json` file that provides metadata for all files in that folder.

### File Location

```
{folder}/metadata.json
```

### Format

```json
{
  "type": "transcribefoldermetadata",
  "version": 1,
  "creation_date": "2024-01-15T10:30:00.000Z",
  "collection": "Meeting Notes",
  "title": "January 2024 Meetings"
}
```

### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | string | Yes | Must be `"transcribefoldermetadata"` |
| `version` | number | No | Schema version number |
| `collection` | string | Yes | Collection/category name |
| `title` | string | Yes | Title for the folder's contents |
| `creation_date` | string | No | ISO 8601 datetime, overrides S3 lastModified |

### Behavior

- All files in a folder inherit metadata from that folder's `metadata.json`
- If `metadata.json` is missing, `collection` and `title` are null
- If `creation_date` is valid, it overrides S3's lastModified timestamp
- If `creation_date` is invalid or missing, falls back to S3's lastModified
- The `has_metadata` flag indicates whether metadata was found (1) or not (0)

### Error Handling

- Missing metadata files silently return null (metadata is optional)
- JSON parse errors are logged as warnings
- Invalid dates are logged as warnings with fallback to S3 timestamp
- Fetch timeouts (30 seconds) are logged as warnings

## API Endpoints

### Document Operations

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/documents/list` | List all documents (from database) |
| GET | `/api/documents/recent` | List recent `.txt` and `.md` files |
| GET | `/api/documents/download?key=<encoded>` | Download a file |
| GET | `/api/documents/preview?key=<encoded>` | Preview `.txt` or `.md` file content |

### Search Operations

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/search?q=<query>` | Search indexed files |
| POST | `/api/search/reindex` | Trigger full reindex |
| GET | `/api/search/reindex/status` | Check reindex status |
| GET | `/api/search/stats` | Get index statistics |

### Notes

- File keys are base64url encoded in API requests
- The main server runs on port 3000 (configurable)
- The job runner runs on port 3001 (configurable via `JOB_RUNNER_URL`)

## Data Flow

```
S3 Storage
├── folder/
│   ├── file.txt
│   ├── file.md
│   └── metadata.json
│
└──→ Reindex Process
    ├── List all S3 objects
    ├── Filter .txt/.md files
    ├── Group by folder
    ├── Fetch metadata.json per folder
    ├── Fetch file content
    └── Insert to SQLite
        │
        └──→ Database
            ├── documents (main table)
            ├── documents_fts (search index)
            └── schema_version

API Queries
└──→ FTS5 search with highlighted results
```
