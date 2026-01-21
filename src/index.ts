import { serve } from "bun";
import index from "./index.html";
import { s3 } from "./lib/s3";
import { getIndex } from "./lib/meilisearch";
import { getIndexStats } from "./lib/indexer";

// Decode base64 URL-safe encoded key
function decodeKey(encoded: string): string {
  return Buffer.from(encoded, "base64url").toString("utf-8");
}

const JOB_RUNNER_URL = process.env.JOB_RUNNER_URL || "http://localhost:3001";

const server = serve({
  routes: {
    // Serve index.html for all unmatched routes.
    "/*": index,

    // S3 API Routes
    "/api/s3/list": {
      async GET(_req) {
        try {
          const result = await s3.list();
          const objects = (result.contents || []).map((obj) => ({
            key: obj.key,
            size: obj.size || 0,
            lastModified: obj.lastModified || new Date().toISOString(),
          }));
          return Response.json({ objects });
        } catch (error) {
          return Response.json(
            { error: error instanceof Error ? error.message : "Failed to list objects" },
            { status: 500 }
          );
        }
      },
    },

    "/api/s3/upload": {
      async POST(req) {
        try {
          const formData = await req.formData();
          const file = formData.get("file") as File | null;

          if (!file) {
            return Response.json({ error: "No file provided" }, { status: 400 });
          }

          const key = file.name;
          const arrayBuffer = await file.arrayBuffer();
          await s3.write(key, arrayBuffer);

          return Response.json({
            success: true,
            key,
            size: file.size,
          });
        } catch (error) {
          return Response.json(
            { error: error instanceof Error ? error.message : "Failed to upload file" },
            { status: 500 }
          );
        }
      },
    },

    "/api/s3/download": {
      async GET(req) {
        try {
          const url = new URL(req.url);
          const encodedKey = url.searchParams.get("key");
          if (!encodedKey) {
            return Response.json({ error: "Missing key parameter" }, { status: 400 });
          }
          const key = decodeKey(encodedKey);
          const s3File = s3.file(key);
          const exists = await s3File.exists();

          if (!exists) {
            return Response.json({ error: "File not found" }, { status: 404 });
          }

          const data = await s3File.arrayBuffer();
          const contentType = s3File.type || "application/octet-stream";

          // Extract basename and encode for Content-Disposition header (RFC 5987)
          const basename = key.split("/").pop() || key;
          const encodedFilename = encodeURIComponent(basename).replace(/'/g, "%27");

          return new Response(data, {
            headers: {
              "Content-Type": contentType,
              "Content-Disposition": `attachment; filename*=UTF-8''${encodedFilename}`,
            },
          });
        } catch (error) {
          return Response.json(
            { error: error instanceof Error ? error.message : "Failed to download file" },
            { status: 500 }
          );
        }
      },
    },

    "/api/s3/delete": {
      async DELETE(req) {
        try {
          const url = new URL(req.url);
          const encodedKey = url.searchParams.get("key");
          if (!encodedKey) {
            return Response.json({ error: "Missing key parameter" }, { status: 400 });
          }
          const key = decodeKey(encodedKey);
          await s3.delete(key);
          return Response.json({ success: true, key });
        } catch (error) {
          return Response.json(
            { error: error instanceof Error ? error.message : "Failed to delete file" },
            { status: 500 }
          );
        }
      },
    },

    "/api/s3/preview": {
      async GET(req) {
        try {
          const url = new URL(req.url);
          const encodedKey = url.searchParams.get("key");
          if (!encodedKey) {
            return Response.json({ error: "Missing key parameter" }, { status: 400 });
          }
          const key = decodeKey(encodedKey);
          const ext = key.toLowerCase().split(".").pop();

          // Only allow preview for .txt and .md files
          if (ext !== "txt" && ext !== "md") {
            return Response.json(
              { error: "Preview is only supported for .txt and .md files" },
              { status: 400 }
            );
          }

          const s3File = s3.file(key);
          const exists = await s3File.exists();

          if (!exists) {
            return Response.json({ error: "File not found" }, { status: 404 });
          }

          const content = await s3File.text();
          return new Response(content, {
            headers: {
              "Content-Type": "text/plain; charset=utf-8",
            },
          });
        } catch (error) {
          return Response.json(
            { error: error instanceof Error ? error.message : "Failed to preview file" },
            { status: 500 }
          );
        }
      },
    },

    // Search API Routes
    "/api/search": {
      async GET(req) {
        try {
          const url = new URL(req.url);
          const query = url.searchParams.get("q") || "";
          const limit = parseInt(url.searchParams.get("limit") || "20", 10);
          const offset = parseInt(url.searchParams.get("offset") || "0", 10);

          if (!query.trim()) {
            return Response.json({ hits: [], query: "", totalHits: 0 });
          }

          const searchIndex = await getIndex();
          const results = await searchIndex.search(query, {
            limit,
            offset,
            attributesToHighlight: ["name", "content"],
            attributesToCrop: ["content"],
            cropLength: 200,
            highlightPreTag: "<mark>",
            highlightPostTag: "</mark>",
          });

          return Response.json({
            hits: results.hits,
            query: results.query,
            totalHits: results.estimatedTotalHits || results.hits.length,
            processingTimeMs: results.processingTimeMs,
          });
        } catch (error) {
          return Response.json(
            { error: error instanceof Error ? error.message : "Search failed" },
            { status: 500 }
          );
        }
      },
    },

    "/api/search/reindex": {
      async POST() {
        try {
          const response = await fetch(`${JOB_RUNNER_URL}/reindex`, {
            method: "POST",
          });
          const data = await response.json();
          return Response.json(data, { status: response.status });
        } catch (error) {
          return Response.json(
            { error: "Job runner unavailable" },
            { status: 503 }
          );
        }
      },
    },

    "/api/search/reindex/status": {
      async GET() {
        try {
          const response = await fetch(`${JOB_RUNNER_URL}/status`);
          const data = await response.json();
          return Response.json(data);
        } catch (error) {
          return Response.json(
            { running: false, error: "Job runner unavailable" },
            { status: 503 }
          );
        }
      },
    },

    "/api/search/stats": {
      async GET() {
        try {
          const stats = await getIndexStats();
          return Response.json(stats);
        } catch (error) {
          return Response.json(
            { error: error instanceof Error ? error.message : "Failed to get stats" },
            { status: 500 }
          );
        }
      },
    },

    // Recent files endpoint - returns recently updated .txt and .md files directly from S3
    "/api/s3/recent": {
      async GET(req) {
        try {
          const url = new URL(req.url);
          const limit = parseInt(url.searchParams.get("limit") || "50", 10);
          const offset = parseInt(url.searchParams.get("offset") || "0", 10);

          // Fetch all files from S3
          const result = await s3.list();
          const allObjects = result.contents || [];

          // Filter for .txt and .md files only
          const textFiles = allObjects.filter((obj) => {
            if (!obj.key) return false;
            const ext = obj.key.toLowerCase().split(".").pop();
            return ext === "txt" || ext === "md";
          });

          // Sort by lastModified descending (most recent first)
          textFiles.sort((a, b) => {
            const dateA = a.lastModified ? new Date(a.lastModified).getTime() : 0;
            const dateB = b.lastModified ? new Date(b.lastModified).getTime() : 0;
            return dateB - dateA;
          });

          // Apply pagination
          const paginatedFiles = textFiles.slice(offset, offset + limit);

          // Map to response format
          const files = paginatedFiles.map((obj) => ({
            key: obj.key,
            name: obj.key?.split("/").pop() || obj.key,
            path: obj.key?.split("/").slice(0, -1).join("/") || "",
            size: obj.size || 0,
            lastModified: obj.lastModified ? new Date(obj.lastModified).getTime() : 0,
            lastModifiedISO: obj.lastModified || new Date().toISOString(),
          }));

          return Response.json({
            files,
            totalFiles: textFiles.length,
          });
        } catch (error) {
          return Response.json(
            { error: error instanceof Error ? error.message : "Failed to get recent files" },
            { status: 500 }
          );
        }
      },
    },
  },

  development: process.env.NODE_ENV !== "production" && {
    // Enable browser hot reloading in development
    hmr: true,

    // Echo console logs from the browser to the server
    console: true,
  },
});

console.log(`🚀 Server running at ${server.url}`);
