import { s3 } from "./s3";
import {
  addDocument,
  addDocuments,
  deleteDocument,
  deleteAllDocuments,
  getStats,
  keyToId,
  type S3FileDocument,
} from "./search-db";

const INDEXABLE_EXTENSIONS = ["txt", "md"];
const CONTENT_PREVIEW_LENGTH = 500;

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

export interface IndexStats {
  numberOfDocuments: number;
  isIndexing: boolean;
  lastUpdate?: string;
}

export async function indexFile(
  key: string,
  size: number,
  lastModified: Date
): Promise<boolean> {
  if (!isIndexable(key)) {
    return false;
  }

  try {
    const content = await s3.file(key).text();
    const contentPreview = content.slice(0, CONTENT_PREVIEW_LENGTH);

    const document: S3FileDocument = {
      id: keyToId(key),
      key,
      name: getBasename(key),
      extension: getExtension(key),
      path: getPath(key),
      size,
      lastModified: lastModified.getTime(),
      lastModifiedISO: lastModified.toISOString(),
      content,
      contentPreview,
    };

    await addDocument(document);
    return true;
  } catch (error) {
    console.error(`Failed to index file ${key}:`, error);
    return false;
  }
}

export async function removeFromIndex(key: string): Promise<boolean> {
  try {
    await deleteDocument(key);
    return true;
  } catch (error) {
    console.error(`Failed to remove ${key} from index:`, error);
    return false;
  }
}

export interface ReindexResult {
  total: number;
  indexed: number;
  skipped: number;
  errors: string[];
}

const BATCH_SIZE = 20; // Process 20 files in parallel

export async function fullReindex(): Promise<ReindexResult> {
  const result: ReindexResult = {
    total: 0,
    indexed: 0,
    skipped: 0,
    errors: [],
  };

  try {
    console.log("[Indexer] Deleting all documents...");
    await deleteAllDocuments();

    console.log("[Indexer] Listing S3 files...");
    const listResult = await s3.list();
    const objects = listResult.contents || [];

    result.total = objects.length;

    // Filter to indexable files only
    const indexableObjects = objects.filter(
      (obj) => obj.key && isIndexable(obj.key)
    );
    result.skipped = objects.length - indexableObjects.length;
    console.log(
      `[Indexer] Found ${objects.length} total files, ${indexableObjects.length} indexable`
    );

    const documents: S3FileDocument[] = [];
    let processed = 0;

    // Process in parallel batches
    for (let i = 0; i < indexableObjects.length; i += BATCH_SIZE) {
      const batch = indexableObjects.slice(i, i + BATCH_SIZE);

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
          documents.push(res.value);
        } else {
          result.errors.push(res.reason?.message || "Unknown error");
        }
      }

      processed += batch.length;
      console.log(
        `[Indexer] Processed ${processed}/${indexableObjects.length} files...`
      );
    }

    console.log(`[Indexer] Adding ${documents.length} documents to index...`);
    if (documents.length > 0) {
      await addDocuments(documents);
      result.indexed = documents.length;
    }

    console.log("[Indexer] Done!");
    return result;
  } catch (error) {
    console.error("[Indexer] Error:", error);
    result.errors.push(
      `Full reindex failed: ${error instanceof Error ? error.message : "Unknown error"}`
    );
    return result;
  }
}

export async function getIndexStats(): Promise<IndexStats> {
  try {
    const stats = getStats();

    return {
      numberOfDocuments: stats.numberOfDocuments,
      isIndexing: stats.isIndexing,
    };
  } catch (error) {
    console.error("Failed to get index stats:", error);
    return {
      numberOfDocuments: 0,
      isIndexing: false,
    };
  }
}
