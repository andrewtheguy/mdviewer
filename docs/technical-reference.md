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

#### `sync_status`

Tracks incremental sync state. Preserved across restarts, cleared on full reindex.

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PRIMARY KEY | Always 1 (single row) |
| `last_source_timestamp` | INTEGER | Max `chapter_updated_date` in Unix seconds |
| `last_synced_at` | INTEGER | `Date.now()` in milliseconds when last sync ran |

### Indexes

- `idx_documents_key` - On `key` for fast lookups
- `idx_documents_creation_date` - On `creation_date` DESC for sorting recent items
- `idx_documents_collection_title_name` - **UNIQUE** on `(collection, title, name)` - prevents duplicate filenames within collection+title
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

## Incremental Sync

The job runner supports incremental sync to update only changed entries without a full reindex. This is controlled by a timestamp manifest file in S3.

### How It Works

1. **Periodic Check** - The job runner checks for updates at a configurable interval (default: 15 minutes)
2. **Fetch Manifest** - Reads `{S3_INDEX_PREFIX}/timestamp_v1.json` from S3
   - If `S3_INDEX_PREFIX` is not set, defaults to `timestamp_v1.json` at the bucket root
3. **Compare Timestamps** - Compares each entry's `chapter_updated_date` against the stored `last_source_timestamp`
4. **Partial Reindex** - Only entries with timestamps >= the stored timestamp are reindexed
5. **Update Timestamp** - On success (no errors), stores the max timestamp for future comparisons

### Timestamp Manifest Format

The manifest file `{S3_INDEX_PREFIX}/timestamp_v1.json` is a JSON array of entries:

```json
[
  {
    "storage_prefix": "transcripts/folder1/",
    "chapter_updated_date": "2024-01-15T10:30:00.000Z"
  },
  {
    "storage_prefix": "transcripts/folder2/",
    "chapter_updated_date": "2024-01-16T14:00:00.000Z"
  }
]
```

| Field | Type | Description |
|-------|------|-------------|
| `storage_prefix` | string | S3 path prefix to reindex |
| `chapter_updated_date` | string | ISO 8601 datetime of last update |

### Sync Behavior

| Scenario | Behavior |
|----------|----------|
| Manifest missing | Logs info, skips sync |
| Invalid JSON | Throws error, skips sync |
| DB timestamp is null | Sets `needsFullReindex` flag, blocks API |
| DB timestamp < earliest manifest entry | Sets `needsFullReindex` flag, blocks API |
| Sync errors during partial reindex | Timestamp not updated, failed entries retry next sync |
| Reindex or sync already running | Skips (mutual exclusion) |

### Sync Status

Check sync status via `GET /sync/status` on the job runner (port 3001):

```json
{
  "enabled": true,
  "intervalS": 900,
  "lastSourceTimestamp": 1705315800,
  "lastSyncedAt": 1705316000000,
  "needsFullReindex": false
}
```

### Full Reindex Required

When the sync detects that the database is too far behind (timestamp is null or older than the earliest manifest entry), it sets `needsFullReindex` to true. This blocks the API (returns 503) until a full reindex is completed.

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
| `version` | number | Yes | Must be `1` |
| `collection` | string | Yes | Collection/category name |
| `title` | string | Yes | Title for the folder's contents |
| `creation_date` | string | No | ISO 8601 datetime, overrides S3 lastModified |

**Important:** The `metadata.json` file is **required** for a folder's files to be indexed. Files in folders without valid `metadata.json` are skipped during reindex.

### Behavior

- All files in a folder inherit metadata from that folder's `metadata.json`
- **Files in folders without `metadata.json` are skipped during indexing**
- If `creation_date` is valid, it overrides S3's lastModified timestamp
- If `creation_date` is invalid or missing, falls back to S3's lastModified

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

### Authentication Configuration

| Variable | Required | Description |
|----------|----------|-------------|
| `AUTH_DISABLED` | No | Set to `true` to disable authentication (default: `false`) |
| `AUTH_CREDENTIAL_B64` | Yes (when auth enabled) | Base64-encoded `username:bcryptHash` value (`bcryptHash` must be `$2a$`, `$2b$`, or `$2y$`) |

### Sync Configuration

| Variable | Required | Description |
|----------|----------|-------------|
| `SYNC_ENABLED` | No | Enable periodic sync checks (default: `true`, set to `false` to disable) |
| `SYNC_CHECK_INTERVAL_S` | No | Interval between sync checks in seconds (default: `900` = 15 minutes). Must be a positive integer; invalid values cause startup failure. |

## API Endpoints

### Document Operations

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/documents/list` | List all documents (from database) |
| GET | `/api/documents/recent` | List recent `.txt` and `.md` files |
| GET | `/api/documents/download?key=<encoded>` | Download a file |
| GET | `/api/documents/preview?key=<encoded>` | Preview `.txt` or `.md` file content |

### Authentication Operations

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/auth/login` | Authenticate with username/password and set session cookie |
| POST | `/api/auth/logout` | Clear active auth session |
| GET | `/api/auth/check` | Check whether current request is authenticated |

### Search Operations

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/search?q=<query>` | Search indexed files |
| POST | `/api/search/reindex` | Trigger full reindex |
| GET | `/api/search/reindex/status` | Check reindex status |
| GET | `/api/search/stats` | Get index statistics |

### Sync Operations (Job Runner - port 3001)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/sync/status` | Check sync status and configuration |

### Notes

- File keys are base64url encoded in API requests
- The main server runs on port 3000 (configurable)
- The job runner runs on port 3001 (configurable via `JOB_RUNNER_URL`)

## Data Flow

```
S3 Storage
├── {S3_INDEX_PREFIX}/
│   ├── timestamp_v1.json  (sync manifest)
│   └── folder/
│       ├── file.txt
│       ├── file.md
│       └── metadata.json
│
├──→ Full Reindex (on demand)
│   ├── List all S3 objects
│   ├── Filter .txt/.md files
│   ├── Group by folder
│   ├── Fetch metadata.json per folder
│   ├── Fetch file content
│   ├── Clear and rebuild database
│   └── Set sync timestamp from manifest
│
└──→ Incremental Sync (periodic)
    ├── Fetch timestamp_v1.json
    ├── Compare with stored timestamp
    ├── Reindex only updated prefixes
    └── Update stored timestamp
        │
        └──→ Database
            ├── documents (main table)
            ├── documents_fts (search index)
            ├── schema_version
            └── sync_status

API Queries
└──→ FTS5 search with highlighted results
```
