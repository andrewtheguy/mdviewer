import { Button } from "@/components/ui/button";
import { Pagination } from "@/components/Pagination";
import { Eye, Download, FileText, ChevronLeft, FolderOpen, BookOpen, ArrowUpDown, ArrowUp, ArrowDown } from "lucide-react";

// Sorting types (mirrored from hook)
export type SortField = "name" | "date";
export type SortOrder = "asc" | "desc";

export interface SortState {
  sortBy: SortField;
  sortOrder: SortOrder;
}

export interface CollectionSummary {
  name: string;
  latestCreationDate: string | null;
}

export interface CollectionTitle {
  title: string;  // "Untitled" for null titles
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
  // Title level
  titles: CollectionTitle[];
  totalTitles: number;
  titlesCurrentPage: number;
  onTitlesPageChange: (page: number) => void;
  selectedTitle: string | null;
  onSelectTitle: (title: string) => void;
  onTitleBack: () => void;
  // Transcripts level
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
  // Sorting
  collectionSort: SortState;
  titleSort: SortState;
  transcriptSort: SortState;
  onCollectionSortChange: (sort: SortState) => void;
  onTitleSortChange: (sort: SortState) => void;
  onTranscriptSortChange: (sort: SortState) => void;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes === 0) return "0 Bytes";
  const isNegative = bytes < 0;
  const absBytes = Math.abs(bytes);
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(absBytes) / Math.log(k)), sizes.length - 1);
  const formatted = parseFloat((absBytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
  return isNegative ? "-" + formatted : formatted;
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
    return new Date(isoDate).toLocaleString();
  } catch {
    return "Unknown";
  }
}

// Sortable column header component
function SortableHeader({
  label,
  field,
  currentSort,
  onSort,
  align = "left",
}: {
  label: string;
  field: SortField;
  currentSort: SortState;
  onSort: (sort: SortState) => void;
  align?: "left" | "right";
}) {
  const isActive = currentSort.sortBy === field;

  const handleClick = () => {
    if (isActive) {
      // Toggle order if already sorting by this field
      onSort({ sortBy: field, sortOrder: currentSort.sortOrder === "asc" ? "desc" : "asc" });
    } else {
      // Default to descending when switching to a new field
      onSort({ sortBy: field, sortOrder: "desc" });
    }
  };

  const SortIcon = isActive
    ? currentSort.sortOrder === "asc"
      ? ArrowUp
      : ArrowDown
    : ArrowUpDown;

  return (
    <th
      className={`p-3 font-medium cursor-pointer hover:bg-muted/70 select-none ${align === "right" ? "text-right" : "text-left"}`}
      onClick={handleClick}
    >
      <div className={`flex items-center gap-1 ${align === "right" ? "justify-end" : ""}`}>
        <span>{label}</span>
        <SortIcon className={`size-3 ${isActive ? "opacity-100" : "opacity-50"}`} />
      </div>
    </th>
  );
}

export function CollectionsView({
  collections,
  totalCollections,
  collectionsCurrentPage,
  onCollectionsPageChange,
  selectedCollection,
  titles,
  totalTitles,
  titlesCurrentPage,
  onTitlesPageChange,
  selectedTitle,
  onSelectTitle,
  onTitleBack,
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
  collectionSort,
  titleSort,
  transcriptSort,
  onCollectionSortChange,
  onTitleSortChange,
  onTranscriptSortChange,
}: CollectionsViewProps) {
  const totalTranscriptPages = pageSize <= 0 ? 0 : Math.ceil(totalTranscripts / pageSize);
  const totalCollectionPages = pageSize <= 0 ? 0 : Math.ceil(totalCollections / pageSize);
  const totalTitlePages = pageSize <= 0 ? 0 : Math.ceil(totalTitles / pageSize);

  if (loading) {
    return (
      <div className="text-center text-muted-foreground py-8">
        Loading...
      </div>
    );
  }

  // Level 1: No collection selected - show collection list
  if (!selectedCollection) {
    if (collections.length === 0) {
      return (
        <div className="space-y-4">
          <div className="text-sm text-muted-foreground px-4 sm:px-0">
            No collections found. Collections are created from metadata.json files.
          </div>
        </div>
      );
    }

    return (
      <div className="space-y-4">
        <div className="bg-muted/30 p-3 sm:rounded-lg border-0 sm:border rounded-none">
          <div className="text-sm font-medium">
            Collections <span className="text-muted-foreground font-normal">({totalCollections})</span>
          </div>
        </div>

        <div className="border rounded-lg overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <SortableHeader
                  label="Collection"
                  field="name"
                  currentSort={collectionSort}
                  onSort={onCollectionSortChange}
                />
                <SortableHeader
                  label="Latest"
                  field="date"
                  currentSort={collectionSort}
                  onSort={onCollectionSortChange}
                  align="right"
                />
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
                  <td className="p-3 text-right text-muted-foreground">
                    {formatISODate(collection.latestCreationDate)}
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

  // Level 2: Collection selected but no title - show titles list
  if (!selectedTitle) {
    if (titles.length === 0) {
      return (
        <div className="space-y-4">
          <div className="flex items-center gap-3 bg-muted/30 p-3 sm:rounded-lg border-0 sm:border rounded-none">
            <Button variant="ghost" size="sm" onClick={onBack} className="gap-2">
              <ChevronLeft className="size-4" />
              Back
            </Button>
            <div className="h-4 w-px bg-border" />
            <div className="text-sm">
              <span className="font-medium">{selectedCollection}</span>
            </div>
          </div>
          <div className="text-center text-muted-foreground py-8">
            No titles found in this collection
          </div>
        </div>
      );
    }

    return (
      <div className="space-y-4">
        <div className="flex items-center gap-3 bg-muted/30 p-3 sm:rounded-lg border-0 sm:border rounded-none">
          <Button variant="ghost" size="sm" onClick={onBack} className="gap-2">
            <ChevronLeft className="size-4" />
            Back
          </Button>
          <div className="h-4 w-px bg-border" />
          <div className="text-sm">
            <span className="font-medium">{selectedCollection}</span>
          </div>
        </div>

        <div className="border rounded-lg overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <SortableHeader
                  label="Title"
                  field="name"
                  currentSort={titleSort}
                  onSort={onTitleSortChange}
                />
                <SortableHeader
                  label="Latest"
                  field="date"
                  currentSort={titleSort}
                  onSort={onTitleSortChange}
                  align="right"
                />
              </tr>
            </thead>
            <tbody>
              {titles.map((titleItem) => (
                <tr
                  key={titleItem.title}
                  className="border-t hover:bg-muted/30 cursor-pointer"
                  onClick={() => onSelectTitle(titleItem.title)}
                >
                  <td className="p-3">
                    <div className="flex items-center gap-2">
                      <BookOpen className="size-4 shrink-0" />
                      <span className={`font-medium break-all ${titleItem.title === "Untitled" ? "text-muted-foreground italic" : ""}`}>
                        {titleItem.title}
                      </span>
                    </div>
                  </td>
                  <td className="p-3 text-right text-muted-foreground">
                    {formatISODate(titleItem.latestCreationDate)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <Pagination
          currentPage={titlesCurrentPage}
          totalPages={totalTitlePages}
          totalItems={totalTitles}
          pageSize={pageSize}
          loading={loading}
          onPageChange={onTitlesPageChange}
        />
      </div>
    );
  }

  // Level 3: Collection and title selected - show files with extensions (filename, not title)
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 bg-muted/30 p-3 sm:rounded-lg border-0 sm:border rounded-none">
        <Button variant="ghost" size="sm" onClick={onTitleBack} className="gap-2">
          <ChevronLeft className="size-4" />
          Back
        </Button>
        <div className="h-4 w-px bg-border" />
        <div className="text-sm">
          <span className="text-muted-foreground">{selectedCollection}</span>
          <span className="mx-1">›</span>
          <span className={`font-medium ${selectedTitle === "Untitled" ? "text-muted-foreground italic" : ""}`}>
            {selectedTitle}
          </span>
        </div>
      </div>

      {transcripts.length === 0 ? (
        <div className="text-center text-muted-foreground py-8">
          No files found for this title
        </div>
      ) : (
        <>
          <div className="border rounded-lg overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <SortableHeader
                    label="File"
                    field="name"
                    currentSort={transcriptSort}
                    onSort={onTranscriptSortChange}
                  />
                  <SortableHeader
                    label="Created"
                    field="date"
                    currentSort={transcriptSort}
                    onSort={onTranscriptSortChange}
                  />
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
                      <div className="flex items-center gap-2">
                        <FileText className="size-4 shrink-0" />
                        <span className="break-all font-medium">
                          {transcript.name}
                        </span>
                        <span className="text-muted-foreground text-xs whitespace-nowrap hidden sm:inline">
                          ({formatBytes(transcript.size)})
                        </span>
                      </div>
                    </td>
                    <td className="p-3">
                      {transcript.creationDate ? (
                        <div className="flex flex-col gap-0.5">
                          <span className="text-sm">{getRelativeTime(transcript.creationDate)}</span>
                          <span className="text-xs text-muted-foreground hidden sm:block">
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
