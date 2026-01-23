# Markdown Viewer

A web-based markdown viewer from S3 storage and full-text search powered by SQLite FTS5. Built with Node.js, React, and Tailwind CSS.

> [!IMPORTANT]
> This application is designed for self-hosted S3-compatible storage like [Garage](https://garagehq.deuxfleurs.fr/) or [Ceph](https://ceph.io/). It makes frequent API calls to list and fetch files, which may incur significant costs on commercial cloud providers like AWS S3.

## Features

- Browse and view markdown or text files stored in S3
- Rendered markdown preview with styling
- Full-text search across `.txt` and `.md` files using SQLite FTS5
- Highlighted search results with content preview
- Folder navigation and file management

## Prerequisites

- [Node.js](https://nodejs.org) v24+
- S3-compatible storage (Garage, Ceph, etc.)

## Installation

```bash
npm install
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

# SQLite Database Path (optional, defaults to ./data/search.sqlite)
SQLITE_DB_PATH=./data/search.sqlite

# Job Runner URL (optional, defaults to http://localhost:3001)
JOB_RUNNER_URL=http://localhost:3001
```

## Running

### Development

```bash
npm run dev
```

This starts both the backend server and Vite dev server concurrently.

### Production

```bash
npm run build
npm run start
```

The app will be available at http://localhost:3000

### Job Runner

The job runner handles background tasks like reindexing:

```bash
npm run job-runner
```

## Docker

Build and run with Docker:

```bash
docker build -t mdviewer .
docker run -p 3000:3000 --env-file .env mdviewer
```

Or use Docker Compose:

```bash
docker-compose up
```

## Search

Only `.txt` and `.md` files are indexed for search. The search includes:

- File names
- File content

Search results display highlighted matches and allow you to:
- Preview the file
- Download the file
- Navigate to the file's folder

## Tech Stack

- **Runtime**: [Node.js](https://nodejs.org) 24
- **Frontend**: React 19, Tailwind CSS, shadcn/ui
- **Search**: SQLite FTS5 (via better-sqlite3)
- **Storage**: AWS SDK for S3-compatible storage
- **Markdown**: react-markdown with @tailwindcss/typography

## Documentation

See [docs/technical-reference.md](docs/technical-reference.md) for detailed documentation on:
- Database schema
- Reindex flow
- Metadata JSON format
- API endpoints
