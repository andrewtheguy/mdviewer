import { getStats } from "./search-db";

export interface IndexStats {
  numberOfDocuments: number;
  isIndexing: boolean;
  lastUpdate?: string;
}

export function getIndexStats(): IndexStats {
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
