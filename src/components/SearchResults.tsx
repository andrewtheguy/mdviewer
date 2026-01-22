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
  collection: string | null;
  title: string | null;
  creationDate: number | null;
  creationDateISO: string | null;
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
  currentPage: number;
  pageSize: number;
  loading: boolean;
  onPageChange: (page: number) => void;
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
  currentPage,
  pageSize,
  loading,
  onPageChange,
}: SearchResultsProps) {
  const totalPages = pageSize <= 0 ? 0 : Math.ceil(totalHits / pageSize);
  if (hits.length === 0) {
    return (
      <div className="text-center text-muted-foreground py-8">
        No results found for "{query}"
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="text-sm text-muted-foreground mb-4 px-4 sm:px-0">
        Found {totalHits} result{totalHits !== 1 ? "s" : ""} for "{query}"
      </div>

      <div className="border-0 sm:border rounded-none sm:rounded-lg overflow-x-auto">
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
                  className="border-t hover:bg-muted/30 cursor-pointer"
                  onClick={() => onPreview(hit.key)}
                >
                  <td className="p-3">
                    <div className="flex flex-col gap-1">
                      <div className="flex items-center gap-2">
                        <FileText className="size-4 shrink-0" />
                        {hit._formatted?.name ? (
                          <span className="font-medium">
                            <HighlightedText html={hit._formatted.name} />
                          </span>
                        ) : (
                          <span className="break-all font-medium">{hit.title || hit.name}</span>
                        )}
                        <span className="text-muted-foreground text-xs whitespace-nowrap hidden sm:inline">
                          ({formatBytes(hit.size)})
                        </span>
                      </div>
                      {hit.collection && (
                        <span className="inline-flex items-center w-fit px-2 py-0.5 rounded-full text-xs bg-primary/10 text-primary">
                          {hit.collection}
                        </span>
                      )}
                      {hit.path && (
                        <span className="text-xs text-muted-foreground break-all">
                          /{hit.path}
                        </span>
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
                  <td
                    className="p-3 text-right space-x-1 whitespace-nowrap"
                    onClick={(e) => e.stopPropagation()}
                  >
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
        currentPage={currentPage}
        totalPages={totalPages}
        totalItems={totalHits}
        pageSize={pageSize}
        loading={loading}
        onPageChange={onPageChange}
      />
    </div>
  );
}
