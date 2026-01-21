import { MeiliSearch, Index } from "meilisearch";

const host = process.env.MEILISEARCH_HOST || "http://localhost:7700";
const apiKey = process.env.MEILISEARCH_API_KEY || "aSampleMasterKey";
const indexName = process.env.MEILISEARCH_INDEX || "s3_files";

export const meiliClient = new MeiliSearch({
  host,
  apiKey,
});

export interface S3FileDocument {
  id: string;
  key: string;
  name: string;
  extension: string;
  path: string;
  size: number;
  lastModified: number;
  lastModifiedISO: string;
  content: string;
  contentPreview: string;
}

// Encode S3 key to Meilisearch-safe ID (base64url)
export function keyToId(key: string): string {
  return Buffer.from(key, "utf-8").toString("base64url");
}

// Decode Meilisearch ID back to S3 key
export function idToKey(id: string): string {
  return Buffer.from(id, "base64url").toString("utf-8");
}

let cachedIndex: Index<S3FileDocument> | null = null;

export async function getIndex(): Promise<Index<S3FileDocument>> {
  if (cachedIndex) {
    return cachedIndex;
  }

  try {
    // Try to get existing index
    cachedIndex = meiliClient.index<S3FileDocument>(indexName);
    await cachedIndex.getStats();
  } catch {
    // Create index if it doesn't exist
    await meiliClient.createIndex(indexName, { primaryKey: "id" });
    cachedIndex = meiliClient.index<S3FileDocument>(indexName);

    // Configure searchable and filterable attributes
    await cachedIndex.updateSettings({
      searchableAttributes: ["name", "content", "path", "key"],
      filterableAttributes: ["extension", "path"],
      sortableAttributes: ["lastModified", "size", "name"],
      displayedAttributes: [
        "id",
        "key",
        "name",
        "extension",
        "path",
        "size",
        "lastModified",
        "lastModifiedISO",
        "contentPreview",
      ],
    });
  }

  return cachedIndex;
}
