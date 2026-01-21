import { s3 } from "./s3";
import { getIndex, keyToId, type S3FileDocument } from "./meilisearch";

const INDEXABLE_EXTENSIONS = ["txt", "md"];
const CONTENT_PREVIEW_LENGTH = 500;
const DOWNLOAD_BATCH_SIZE = 20; // Files to download in parallel
const INDEX_BATCH_SIZE = 100; // Documents to send to Meilisearch at once

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

async function runReindex() {
  const result = {
    total: 0,
    indexed: 0,
    skipped: 0,
    errors: 0,
  };

  try {
    console.log("[Worker] Getting index...");
    const index = await getIndex();

    console.log("[Worker] Deleting all documents...");
    await index.deleteAllDocuments();

    console.log("[Worker] Listing S3 files...");
    const listResult = await s3.list();
    const objects = listResult.contents || [];

    result.total = objects.length;

    const indexableObjects = objects.filter(
      (obj) => obj.key && isIndexable(obj.key)
    );
    result.skipped = objects.length - indexableObjects.length;
    console.log(
      `[Worker] Found ${objects.length} total files, ${indexableObjects.length} indexable`
    );

    let pendingDocuments: S3FileDocument[] = [];
    let processed = 0;

    for (let i = 0; i < indexableObjects.length; i += DOWNLOAD_BATCH_SIZE) {
      const batch = indexableObjects.slice(i, i + DOWNLOAD_BATCH_SIZE);

      const batchResults = await Promise.allSettled(
        batch.map(async (obj) => {
          const content = await s3.file(obj.key!).text();
          const contentPreview = content.slice(0, CONTENT_PREVIEW_LENGTH);
          const lastModified = obj.lastModified
            ? new Date(obj.lastModified)
            : new Date();

          return {
            id: keyToId(obj.key!),
            key: obj.key!,
            name: getBasename(obj.key!),
            extension: getExtension(obj.key!),
            path: getPath(obj.key!),
            size: obj.size || 0,
            lastModified: lastModified.getTime(),
            lastModifiedISO: lastModified.toISOString(),
            content,
            contentPreview,
          } as S3FileDocument;
        })
      );

      for (const res of batchResults) {
        if (res.status === "fulfilled") {
          pendingDocuments.push(res.value);
        } else {
          result.errors++;
        }
      }

      // Add to index in batches to avoid memory issues
      if (pendingDocuments.length >= INDEX_BATCH_SIZE) {
        await index.addDocuments(pendingDocuments);
        result.indexed += pendingDocuments.length;
        pendingDocuments = [];
      }

      processed += batch.length;
      console.log(
        `[Worker] Processed ${processed}/${indexableObjects.length} files (indexed: ${result.indexed})...`
      );
    }

    // Add remaining documents
    if (pendingDocuments.length > 0) {
      console.log(`[Worker] Adding final ${pendingDocuments.length} documents...`);
      await index.addDocuments(pendingDocuments);
      result.indexed += pendingDocuments.length;
    }

    console.log("[Worker] Done!", result);
    process.exit(0);
  } catch (error) {
    console.error("[Worker] Error:", error);
    process.exit(1);
  }
}

runReindex();
