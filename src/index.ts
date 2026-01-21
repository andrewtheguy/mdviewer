import { serve } from "bun";
import index from "./index.html";
import { s3 } from "./lib/s3";

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

    "/api/s3/download/:key": {
      async GET(req) {
        try {
          const key = decodeURIComponent(req.params.key);
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

    "/api/s3/delete/:key": {
      async DELETE(req) {
        try {
          const key = decodeURIComponent(req.params.key);
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

    "/api/s3/preview/:key": {
      async GET(req) {
        try {
          const key = decodeURIComponent(req.params.key);
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
  },

  development: process.env.NODE_ENV !== "production" && {
    // Enable browser hot reloading in development
    hmr: true,

    // Echo console logs from the browser to the server
    console: true,
  },
});

console.log(`🚀 Server running at ${server.url}`);
