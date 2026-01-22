import { Button } from "@/components/ui/button";
import { Pagination } from "@/components/Pagination";

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

      <div className="border rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="text-left p-3 font-medium">File</th>
              <th className="text-left p-3 font-medium">Match</th>
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
                        <svg
                          xmlns="http://www.w3.org/2000/svg"
                          width="16"
                          height="16"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
                          <polyline points="14 2 14 8 20 8" />
                        </svg>
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
                          className="text-xs text-muted-foreground hover:text-primary hover:underline text-left"
                        >
                          /{hit.path}
                        </button>
                      )}
                    </div>
                  </td>
                  <td className="p-3">
                    <div className="text-sm text-muted-foreground">
                      {hit._formatted?.content ? (
                        <HighlightedText html={hit._formatted.content} />
                      ) : (
                        hit.contentPreview
                      )}
                    </div>
                  </td>
                  <td className="p-3 text-right space-x-2 whitespace-nowrap">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => onPreview(hit.key)}
                    >
                      Preview
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => onDownload(hit.key)}
                    >
                      Download
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
