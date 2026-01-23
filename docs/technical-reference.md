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
| `size` | INTEGER | File size in bytes |
| `last_modified` | INTEGER | Unix timestamp of last modification |
| `last_modified_iso` | TEXT | ISO 8601 datetime string |
| `content` | TEXT | Full file content |
| `content_preview` | TEXT | First 500 characters of content |
| `collection` | TEXT | Collection name from metadata |
| `title` | TEXT | Title from metadata |
| `creation_date` | INTEGER | Unix timestamp from metadata |
| `creation_date_iso` | TEXT | ISO 8601 creation date |
| `has_metadata` | INTEGER | Boolean flag (0/1), always 1 since metadata is required |

#### `documents_fts`

FTS5 virtual table for full-text search, automatically synchronized with `documents` via triggers.

**Indexed columns:** `name`, `content`, `collection`, `title`

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

- `documents_ai` (AFTER INSERT) - Syncs `name`, `content`, `collection`, `title` to FTS table
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
   - If `S3_INDEX_PREFIX` is set, only files under that prefix are considered

4. **Group by Folder**
   - Files are organized by their directory path

5. **Fetch Metadata (Parallel)**
   - For each unique folder, looks for `metadata.json`
   - Up to 10 concurrent metadata fetches
   - 30-second timeout per file
   - Results are cached to avoid redundant fetches
   - **Files in folders without `metadata.json` are skipped**

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

**Important:** The `metadata.json` file is **required** for a folder's files to be indexed. Files in folders without valid `metadata.json` are skipped during reindex.

### Behavior

- All files in a folder inherit metadata from that folder's `metadata.json`
- **Files in folders without `metadata.json` are skipped during indexing**
- If `creation_date` is valid, it overrides S3's lastModified timestamp
- If `creation_date` is invalid or missing, falls back to S3's lastModified
- The `has_metadata` flag is always 1 since only files with metadata are indexed

### Error Handling

- Missing metadata files cause the folder's files to be skipped
- JSON parse errors are logged as warnings (folder skipped)
- Invalid dates are logged as warnings with fallback to S3 timestamp
- Fetch timeouts (30 seconds) are logged as warnings

## Environment Variables

### S3 Configuration

| Variable | Required | Description |
|----------|----------|-------------|
| `S3_ENDPOINT` | Yes | S3-compatible endpoint URL |
| `S3_ACCESS_KEY_ID` | Yes | S3 access key |
| `S3_SECRET_ACCESS_KEY` | Yes | S3 secret key |
| `S3_BUCKET` | Yes | S3 bucket name |
| `S3_REGION` | No | S3 region (default: `us-east-1`) |
| `S3_INDEX_PREFIX` | No | Only index files with keys starting with this prefix |

### Other Configuration

| Variable | Required | Description |
|----------|----------|-------------|
| `SQLITE_DB_PATH` | No | Path to SQLite database (default: `./data/search.sqlite`) |
| `JOB_RUNNER_URL` | No | URL for job runner service (default: `http://localhost:3001`) |

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
