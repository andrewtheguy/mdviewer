import { Button } from "@/components/ui/button";
import { Pagination } from "@/components/Pagination";
import { Eye, Download, FileText } from "lucide-react";

export interface RecentFile {
  key: string;
  name: string;
  path: string;
  size: number;
  lastModified: number;
  lastModifiedISO: string;
  collection: string | null;
  title: string | null;
  creationDate: number | null;
  creationDateISO: string | null;
}

export type FileTypeFilter = "all" | "txt" | "md";

interface RecentFilesProps {
  files: RecentFile[];
  totalFiles: number;
  loading: boolean;
  typeFilter: FileTypeFilter;
  onTypeFilterChange: (filter: FileTypeFilter) => void;
  onPreview: (key: string) => void;
  onDownload: (key: string) => void;
  currentPage: number;
  pageSize: number;
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

export function RecentFiles({
  files,
  totalFiles,
  loading,
  typeFilter,
  onTypeFilterChange,
  onPreview,
  onDownload,
  currentPage,
  pageSize,
  onPageChange,
}: RecentFilesProps) {
  const totalPages = pageSize <= 0 ? 0 : Math.ceil(totalFiles / pageSize);

  if (loading) {
    return (
      <div className="text-center text-muted-foreground py-8">
        Loading recent files...
      </div>
    );
  }

  if (files.length === 0) {
    return (
      <div className="space-y-4">
        <div className="text-sm text-muted-foreground">
          No recent .txt or .md files found
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center gap-3 bg-muted/30 p-3 sm:rounded-lg border-0 sm:border rounded-none">
        <div className="text-sm font-medium">
          Recent Files <span className="text-muted-foreground font-normal">({totalFiles})</span>
        </div>
        <div className="h-px sm:h-4 w-full sm:w-px bg-border hidden sm:block" />
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground whitespace-nowrap">Filter:</span>
          <select
            value={typeFilter}
            onChange={(e) => onTypeFilterChange(e.target.value as FileTypeFilter)}
            className="text-sm border rounded px-2 py-1 bg-background h-8"
          >
            <option value="all">All Types</option>
            <option value="txt">.txt</option>
            <option value="md">.md</option>
          </select>
        </div>
      </div>

      <div className="border-0 sm:border rounded-none sm:rounded-lg overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="text-left p-3 font-medium">File</th>
              <th className="text-left p-3 font-medium hidden sm:table-cell">Created</th>
              <th className="text-right p-3 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {files.map((file) => {
              const displayDate = file.creationDate ?? file.lastModified;
              return (
                <tr
                  key={file.key}
                  className="border-t hover:bg-muted/30 cursor-pointer"
                  onClick={() => onPreview(file.key)}
                >
                  <td className="p-3">
                    <div className="flex flex-col gap-1">
                      <div className="flex items-center gap-2">
                        <FileText className="size-4 shrink-0" />
                        <span className="break-all font-medium">
                          {file.name}
                        </span>
                        <span className="text-muted-foreground text-xs whitespace-nowrap hidden sm:inline">
                          ({formatBytes(file.size)})
                        </span>
                      </div>
                      {file.title && (
                        <span className="text-xs text-muted-foreground break-all">
                          {file.title}
                        </span>
                      )}
                      {file.collection && (
                        <span className="inline-flex items-center w-fit px-2 py-0.5 rounded-full text-xs bg-primary/10 text-primary">
                          {file.collection}
                        </span>
                      )}
                      <div className="sm:hidden mt-1 text-xs text-muted-foreground">
                        {getRelativeTime(displayDate)} ({formatBytes(file.size)})
                      </div>
                    </div>
                  </td>
                  <td className="p-3 hidden sm:table-cell">
                    <div className="flex flex-col gap-0.5">
                      <span className="text-sm">{getRelativeTime(displayDate)}</span>
                      <span className="text-xs text-muted-foreground">
                        {formatDate(displayDate)}
                      </span>
                    </div>
                  </td>
                  <td
                    className="p-3 text-right space-x-1 whitespace-nowrap"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-8 w-8"
                      onClick={() => onPreview(file.key)}
                      title="Preview"
                    >
                      <Eye className="size-4" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-8 w-8"
                      onClick={() => onDownload(file.key)}
                      title="Download"
                    >
                      <Download className="size-4" />
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <Pagination
        currentPage={currentPage}
        totalPages={totalPages}
        totalItems={totalFiles}
        pageSize={pageSize}
        loading={loading}
        onPageChange={onPageChange}
      />
    </div>
  );
}
