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
  onNavigateToFolder: (path: string) => void;
  onClose: () => void;
  onLoadMore: () => void;
  hasMore: boolean;
  loadingMore: boolean;
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
  onNavigateToFolder,
  onClose,
  onLoadMore,
  hasMore,
  loadingMore,
}: RecentFilesProps) {

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
        <div className="flex items-center justify-between">
          <div className="text-sm text-muted-foreground">
            No recent .txt or .md files found
          </div>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Back to browse
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-4">
          <div className="text-sm text-muted-foreground">
            Showing {files.length} of {totalFiles} file{totalFiles !== 1 ? "s" : ""}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">Type:</span>
            <select
              value={typeFilter}
              onChange={(e) => onTypeFilterChange(e.target.value as FileTypeFilter)}
              className="text-sm border rounded px-2 py-1 bg-background"
            >
              <option value="all">All</option>
              <option value="txt">.txt only</option>
              <option value="md">.md only</option>
            </select>
          </div>
        </div>
        <Button variant="ghost" size="sm" onClick={onClose}>
          Back to browse
        </Button>
      </div>

      <div className="border rounded-lg overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="text-left p-3 font-medium">File</th>
              <th className="text-left p-3 font-medium hidden sm:table-cell">Last Updated</th>
              <th className="text-right p-3 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {files.length === 0 ? (
              <tr>
                <td colSpan={3} className="p-6 text-center text-muted-foreground">
                  No {typeFilter === "all" ? "" : `.${typeFilter} `}files found
                </td>
              </tr>
            ) : files.map((file) => {
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
                        <span className="break-all">{file.name}</span>
                        <span className="text-muted-foreground text-xs whitespace-nowrap">
                          ({formatBytes(file.size)})
                        </span>
                      </div>
                      {file.path && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onNavigateToFolder(file.path);
                          }}
                          className="text-xs text-muted-foreground hover:text-primary hover:underline text-left break-all"
                        >
                          /{file.path}
                        </button>
                      )}
                      <div className="sm:hidden flex flex-col gap-0.5 mt-1 text-muted-foreground">
                        <span className="text-xs font-medium text-foreground">
                          Updated {getRelativeTime(file.lastModified)}
                        </span>
                      </div>
                    </div>
                  </td>
                  <td className="p-3 hidden sm:table-cell">
                    <div className="flex flex-col gap-0.5">
                      <span className="text-sm">{getRelativeTime(file.lastModified)}</span>
                      <span className="text-xs text-muted-foreground">
                        {formatDate(file.lastModified)}
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
        current={files.length}
        total={totalFiles}
        loading={loadingMore}
        hasMore={hasMore}
        onLoadMore={onLoadMore}
      />
    </div>
  );
}
