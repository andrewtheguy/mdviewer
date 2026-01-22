import { Button } from "@/components/ui/button";
import { Pagination } from "@/components/Pagination";
import { Eye, Download, FileText } from "lucide-react";

export interface SearchHit {
  id: string;
  key: string;
  name: string;
  extension: string;
  path: string;
  size: number;
  lastModified: number;
  lastModifiedISO: string;
  contentPreview: string;
  _formatted?: {
    name?: string;
    content?: string;
  };
}

interface SearchResultsProps {
  hits: SearchHit[];
  query: string;
  totalHits: number;
  onPreview: (key: string) => void;
  onDownload: (key: string) => void;
  onNavigateToFolder: (path: string) => void;
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

function HighlightedText({ html }: { html: string }) {
  return (
    <span
      dangerouslySetInnerHTML={{ __html: html }}
      className="[&>mark]:bg-yellow-200 [&>mark]:dark:bg-yellow-800 [&>mark]:px-0.5 [&>mark]:rounded"
    />
  );
}

export function SearchResults({
  hits,
  query,
  totalHits,
  onPreview,
  onDownload,
  onNavigateToFolder,
  onLoadMore,
  hasMore,
  loadingMore,
}: SearchResultsProps) {
  if (hits.length === 0) {
    return (
      <div className="text-center text-muted-foreground py-8">
        No results found for "{query}"
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="text-sm text-muted-foreground mb-4">
        Found {totalHits} result{totalHits !== 1 ? "s" : ""} for "{query}"
      </div>

      <div className="border rounded-lg overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="text-left p-3 font-medium">File</th>
              <th className="text-left p-3 font-medium hidden sm:table-cell">Match</th>
              <th className="text-right p-3 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {hits.map((hit) => {
              return (
                <tr
                  key={hit.id}
                  className="border-t hover:bg-muted/30"
                >
                  <td className="p-3">
                    <div className="flex flex-col gap-1">
                      <div className="flex items-center gap-2">
                        <FileText className="size-4 shrink-0" />
                        {hit._formatted?.name ? (
                          <HighlightedText html={hit._formatted.name} />
                        ) : (
                          <span className="break-all">{hit.name}</span>
                        )}
                        <span className="text-muted-foreground text-xs whitespace-nowrap">
                          ({formatBytes(hit.size)})
                        </span>
                      </div>
                      {hit.path && (
                        <button
                          onClick={() => onNavigateToFolder(hit.path)}
                          className="text-xs text-muted-foreground hover:text-primary hover:underline text-left break-all"
                        >
                          /{hit.path}
                        </button>
                      )}
                      <div className="sm:hidden mt-1 text-xs text-muted-foreground">
                        {hit._formatted?.content ? (
                          <HighlightedText html={hit._formatted.content} />
                        ) : (
                          hit.contentPreview
                        )}
                      </div>
                    </div>
                  </td>
                  <td className="p-3 hidden sm:table-cell">
                    <div className="text-sm text-muted-foreground">
                      {hit._formatted?.content ? (
                        <HighlightedText html={hit._formatted.content} />
                      ) : (
                        hit.contentPreview
                      )}
                    </div>
                  </td>
                  <td className="p-3 text-right space-x-1 whitespace-nowrap">
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-8 w-8"
                      onClick={() => onPreview(hit.key)}
                      title="Preview"
                    >
                      <Eye className="size-4" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-8 w-8"
                      onClick={() => onDownload(hit.key)}
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
        current={hits.length}
        total={totalHits}
        loading={loadingMore}
        hasMore={hasMore}
        onLoadMore={onLoadMore}
      />
    </div>
  );
}
