import { s3 } from "./s3";
import { getIndex, keyToId, type S3FileDocument } from "./meilisearch";

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
    const index = await getIndex();
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

    await index.addDocuments([document]);
    return true;
  } catch (error) {
    console.error(`Failed to index file ${key}:`, error);
    return false;
  }
}

export async function removeFromIndex(key: string): Promise<boolean> {
  try {
    const index = await getIndex();
    await index.deleteDocument(keyToId(key));
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

export async function fullReindex(): Promise<ReindexResult> {
  const result: ReindexResult = {
    total: 0,
    indexed: 0,
    skipped: 0,
    errors: [],
  };

  try {
    const index = await getIndex();

    // Delete all documents first
    await index.deleteAllDocuments();

    // List all files from S3
    const listResult = await s3.list();
    const objects = listResult.contents || [];

    result.total = objects.length;

    const documents: S3FileDocument[] = [];

    for (const obj of objects) {
      if (!obj.key) continue;

      if (!isIndexable(obj.key)) {
        result.skipped++;
        continue;
      }

      try {
        const content = await s3.file(obj.key).text();
        const contentPreview = content.slice(0, CONTENT_PREVIEW_LENGTH);
        const lastModified = obj.lastModified
          ? new Date(obj.lastModified)
          : new Date();

        documents.push({
          id: keyToId(obj.key),
          key: obj.key,
          name: getBasename(obj.key),
          extension: getExtension(obj.key),
          path: getPath(obj.key),
          size: obj.size || 0,
          lastModified: lastModified.getTime(),
          lastModifiedISO: lastModified.toISOString(),
          content,
          contentPreview,
        });
      } catch (error) {
        result.errors.push(
          `${obj.key}: ${error instanceof Error ? error.message : "Unknown error"}`
        );
      }
    }

    // Batch add documents
    if (documents.length > 0) {
      await index.addDocuments(documents);
      result.indexed = documents.length;
    }

    return result;
  } catch (error) {
    result.errors.push(
      `Full reindex failed: ${error instanceof Error ? error.message : "Unknown error"}`
    );
    return result;
  }
}

export async function getIndexStats(): Promise<IndexStats> {
  try {
    const index = await getIndex();
    const stats = await index.getStats();

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
