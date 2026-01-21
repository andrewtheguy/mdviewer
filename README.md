# Markdown Viewer

A web-based markdown viewer with S3 storage and full-text search powered by Meilisearch. Built with Bun, React, and Tailwind CSS.

> [!IMPORTANT]
> This application is designed for self-hosted S3-compatible storage like [Garage](https://garagehq.deuxfleurs.fr/) or [Ceph](https://ceph.io/). It makes frequent API calls to list and fetch files, which may incur significant costs on commercial cloud providers like AWS S3.

## Features

- Browse and view markdown or text files stored in S3
- Rendered markdown preview with styling
- Full-text search across `.txt` and `.md` files using Meilisearch
- Highlighted search results with content preview
- Folder navigation and file management

## Prerequisites

- [Bun](https://bun.sh) v1.3+
- [Meilisearch](https://www.meilisearch.com/) v1.0+
- S3-compatible storage (Garage, Ceph, etc.)

## Installation

```bash
bun install
```

## Configuration

Create a `.env` file with the following variables:

```env
# S3 Configuration
S3_ENDPOINT=https://your-s3-endpoint.com
S3_ACCESS_KEY_ID=your-access-key
S3_SECRET_ACCESS_KEY=your-secret-key
S3_BUCKET=your-bucket-name
S3_REGION=us-east-1

# Meilisearch Configuration
MEILISEARCH_HOST=http://localhost:7700
MEILISEARCH_API_KEY=your-master-key
MEILISEARCH_INDEX=s3_files
```

## Running

### 1. Start Meilisearch

```bash
meilisearch --master-key="your-master-key"
```

### 2. Start the development server

```bash
bun dev
```

Or for production:

```bash
bun start
```

The app will be available at http://localhost:3000

### 3. Index your files

Trigger a full reindex to populate the search index:

```bash
curl -X POST http://localhost:3000/api/search/reindex
```

## API Endpoints

### S3 Operations

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/s3/list` | List all objects in the bucket |
| POST | `/api/s3/upload` | Upload a file (multipart form data) |
| GET | `/api/s3/download?key=<encoded>` | Download a file |
| DELETE | `/api/s3/delete?key=<encoded>` | Delete a file |
| GET | `/api/s3/preview?key=<encoded>` | Preview `.txt` or `.md` file content |

### Search Operations

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/search?q=<query>` | Search indexed files |
| POST | `/api/search/reindex` | Trigger full reindex |
| GET | `/api/search/stats` | Get index statistics |

Note: File keys are base64url encoded in API requests.

## Search

Only `.txt` and `.md` files are indexed for search. The search includes:

- File names
- File content
- File paths

Search results display highlighted matches and allow you to:
- Preview the file
- Download the file
- Navigate to the file's folder

## Project Structure

```
src/
├── index.ts              # Server entry point with API routes
├── index.html            # HTML entry point
├── S3FileManager.tsx     # Main markdown viewer component
├── components/
│   ├── SearchBar.tsx     # Debounced search input
│   ├── SearchResults.tsx # Search results display
│   └── ui/               # shadcn/ui components
└── lib/
    ├── s3.ts             # S3 client wrapper
    ├── meilisearch.ts    # Meilisearch client
    ├── indexer.ts        # File indexing pipeline
    └── utils.ts          # Utility functions
```

## Tech Stack

- **Runtime**: [Bun](https://bun.sh)
- **Frontend**: React 19, Tailwind CSS, shadcn/ui
- **Search**: Meilisearch
- **Storage**: AWS SDK for S3-compatible storage
- **Markdown**: react-markdown with @tailwindcss/typography
