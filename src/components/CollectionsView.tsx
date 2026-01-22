import { Button } from "@/components/ui/button";
import { Pagination } from "@/components/Pagination";
import { Eye, Download, FileText, ChevronLeft, FolderOpen } from "lucide-react";

export interface CollectionSummary {
  name: string;
  count: number;
  latestCreationDate: string | null;
}

export interface CollectionTranscript {
  key: string;
  name: string;
  title: string | null;
  creationDate: number | null;
  creationDateISO: string | null;
  size: number;
}

interface CollectionsViewProps {
  collections: CollectionSummary[];
  totalCollections: number;
  collectionsCurrentPage: number;
  onCollectionsPageChange: (page: number) => void;
  selectedCollection: string | null;
  transcripts: CollectionTranscript[];
  loading: boolean;
  onSelectCollection: (collection: string) => void;
  onBack: () => void;
  onPreview: (key: string) => void;
  onDownload: (key: string) => void;
  currentPage: number;
  pageSize: number;
  totalTranscripts: number;
  onPageChange: (page: number) => void;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 Bytes";
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}

function getRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days} day${days > 1 ? "s" : ""} ago`;
  if (hours > 0) return `${hours} hour${hours > 1 ? "s" : ""} ago`;
  if (minutes > 0) return `${minutes} minute${minutes > 1 ? "s" : ""} ago`;
  return "just now";
}

function formatISODate(isoDate: string | null): string {
  if (!isoDate) return "Unknown";
  try {
    return new Date(isoDate).toLocaleDateString();
  } catch {
    return "Unknown";
  }
}

export function CollectionsView({
  collections,
  totalCollections,
  collectionsCurrentPage,
  onCollectionsPageChange,
  selectedCollection,
  transcripts,
  loading,
  onSelectCollection,
  onBack,
  onPreview,
  onDownload,
  currentPage,
  pageSize,
  totalTranscripts,
  onPageChange,
}: CollectionsViewProps) {
  const totalTranscriptPages = pageSize <= 0 ? 0 : Math.ceil(totalTranscripts / pageSize);
  const totalCollectionPages = pageSize <= 0 ? 0 : Math.ceil(totalCollections / pageSize);

  if (loading) {
    return (
      <div className="text-center text-muted-foreground py-8">
        Loading...
      </div>
    );
  }

  // If no collection selected, show collection list
  if (!selectedCollection) {
    if (collections.length === 0) {
      return (
        <div className="space-y-4">
          <div className="text-sm text-muted-foreground">
            No collections found. Collections are created from metadata.json files.
          </div>
        </div>
      );
    }

    return (
      <div className="space-y-4">
        <div className="bg-muted/30 p-3 rounded-lg border">
          <div className="text-sm font-medium">
            Collections <span className="text-muted-foreground font-normal">({totalCollections})</span>
          </div>
        </div>

        <div className="border rounded-lg overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="text-left p-3 font-medium">Collection</th>
                <th className="text-left p-3 font-medium hidden sm:table-cell">Latest</th>
                <th className="text-right p-3 font-medium">Transcripts</th>
              </tr>
            </thead>
            <tbody>
              {collections.map((collection) => (
                <tr
                  key={collection.name}
                  className="border-t hover:bg-muted/30 cursor-pointer"
                  onClick={() => onSelectCollection(collection.name)}
                >
                  <td className="p-3">
                    <div className="flex items-center gap-2">
                      <FolderOpen className="size-4 shrink-0" />
                      <span className="font-medium break-all">{collection.name}</span>
                    </div>
                  </td>
                  <td className="p-3 hidden sm:table-cell text-muted-foreground">
                    {formatISODate(collection.latestCreationDate)}
                  </td>
                  <td className="p-3 text-right">
                    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs bg-muted">
                      {collection.count}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <Pagination
          currentPage={collectionsCurrentPage}
          totalPages={totalCollectionPages}
          totalItems={totalCollections}
          pageSize={pageSize}
          loading={loading}
          onPageChange={onCollectionsPageChange}
        />
      </div>
    );
  }

  // Show transcripts in the selected collection
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 bg-muted/30 p-3 rounded-lg border">
        <Button variant="ghost" size="sm" onClick={onBack} className="gap-2">
          <ChevronLeft className="size-4" />
          Back
        </Button>
        <div className="h-4 w-px bg-border" />
        <div className="text-sm">
          <span className="font-medium">{selectedCollection}</span>
          <span className="text-muted-foreground ml-2">({totalTranscripts} transcripts)</span>
        </div>
      </div>

      {transcripts.length === 0 ? (
        <div className="text-center text-muted-foreground py-8">
          No transcripts found in this collection
        </div>
      ) : (
        <>
          <div className="border rounded-lg overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="text-left p-3 font-medium">Transcript</th>
                  <th className="text-left p-3 font-medium hidden sm:table-cell">Created</th>
                  <th className="text-right p-3 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {transcripts.map((transcript) => (
                  <tr
                    key={transcript.key}
                    className="border-t hover:bg-muted/30 cursor-pointer"
                    onClick={() => onPreview(transcript.key)}
                  >
                    <td className="p-3">
                      <div className="flex flex-col gap-1">
                        <div className="flex items-center gap-2">
                          <FileText className="size-4 shrink-0" />
                          <span className="break-all font-medium">
                            {transcript.title || transcript.name}
                          </span>
                          <span className="text-muted-foreground text-xs whitespace-nowrap">
                            ({formatBytes(transcript.size)})
                          </span>
                        </div>
                        {transcript.creationDate && (
                          <div className="sm:hidden text-xs text-muted-foreground">
                            {getRelativeTime(transcript.creationDate)}
                          </div>
                        )}
                      </div>
                    </td>
                    <td className="p-3 hidden sm:table-cell">
                      {transcript.creationDate ? (
                        <div className="flex flex-col gap-0.5">
                          <span className="text-sm">{getRelativeTime(transcript.creationDate)}</span>
                          <span className="text-xs text-muted-foreground">
                            {formatDate(transcript.creationDate)}
                          </span>
                        </div>
                      ) : (
                        <span className="text-muted-foreground">Unknown</span>
                      )}
                    </td>
                    <td
                      className="p-3 text-right space-x-1 whitespace-nowrap"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-8 w-8"
                        onClick={() => onPreview(transcript.key)}
                        title="Preview"
                      >
                        <Eye className="size-4" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-8 w-8"
                        onClick={() => onDownload(transcript.key)}
                        title="Download"
                      >
                        <Download className="size-4" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <Pagination
            currentPage={currentPage}
            totalPages={totalTranscriptPages}
            totalItems={totalTranscripts}
            pageSize={pageSize}
            loading={loading}
            onPageChange={onPageChange}
          />
        </>
      )}
    </div>
  );
}
