import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import Markdown from "react-markdown";
import { SearchBar } from "@/components/SearchBar";
import { SearchResults, type SearchHit } from "@/components/SearchResults";

// Encode key as base64 URL-safe
function encodeKey(key: string): string {
  const utf8Bytes = new TextEncoder().encode(key);
  const binaryStr = Array.from(utf8Bytes, (byte) => String.fromCharCode(byte)).join("");
  const base64 = btoa(binaryStr);
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

interface S3Object {
  key: string;
  size: number;
  lastModified: string;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 Bytes";
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

function formatDate(dateString: string): string {
  return new Date(dateString).toLocaleString();
}

// Decode base64 URL-safe key
function decodeKey(encoded: string): string {
  let base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
  while (base64.length % 4) {
    base64 += "=";
  }
  const binaryStr = atob(base64);
  const bytes = Uint8Array.from(binaryStr, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

// Get folder path from URL
function getFolderPathFromURL(): string {
  const match = window.location.pathname.match(/^\/folder\/(.+)$/);
  if (match && match[1]) {
    try {
      return decodeKey(match[1]);
    } catch {
      return "";
    }
  }
  return "";
}

// Process flat S3 keys into folder/file structure at a given path
function getItemsAtPath(objects: S3Object[], path: string) {
  const prefix = path ? path + "/" : "";
  const folders = new Set<string>();
  const files: S3Object[] = [];

  for (const obj of objects) {
    if (!obj.key.startsWith(prefix)) continue;
    const remainder = obj.key.slice(prefix.length);
    if (remainder === "") continue; // Skip if exact match (the folder itself)
    const slashIndex = remainder.indexOf("/");

    if (slashIndex === -1) {
      files.push(obj); // It's a file at this level
    } else {
      folders.add(remainder.slice(0, slashIndex)); // It's a folder
    }
  }
  return { folders: Array.from(folders).sort(), files };
}

export function S3FileManager() {
  const [objects, setObjects] = useState<S3Object[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewContent, setPreviewContent] = useState<string>("");
  const [previewLoading, setPreviewLoading] = useState(false);
  const [currentPath, setCurrentPath] = useState<string>(getFolderPathFromURL);

  // Get preview key from URL
  const getPreviewKeyFromURL = (): string | null => {
    const match = window.location.pathname.match(/^\/preview\/(.+)$/);
    if (match && match[1]) {
      try {
        return decodeKey(match[1]);
      } catch {
        return null;
      }
    }
    return null;
  };

  const [previewFile, setPreviewFile] = useState<string | null>(getPreviewKeyFromURL);

  // Search state
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchHit[]>([]);
  const [searchTotalHits, setSearchTotalHits] = useState(0);
  const [isSearching, setIsSearching] = useState(false);
  const [isSearchMode, setIsSearchMode] = useState(false);

  const isPreviewable = (key: string): boolean => {
    const ext = key.toLowerCase().split(".").pop();
    return ext === "txt" || ext === "md";
  };

  const isMarkdown = (key: string): boolean => {
    return key.toLowerCase().endsWith(".md");
  };

  const fetchObjects = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/s3/list");
      const data = await response.json();
      if (data.error) {
        setError(data.error);
      } else {
        setObjects(data.objects || []);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch objects");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchObjects();
  }, [fetchObjects]);

  const handleDownload = async (key: string) => {
    try {
      const response = await fetch(`/api/s3/download?key=${encodeKey(key)}`);
      if (!response.ok) {
        const data = await response.json();
        setError(data.error || "Failed to download file");
        return;
      }

      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = key.split("/").pop() || key;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to download file");
    }
  };

  const handleDelete = async (key: string) => {
    if (!window.confirm(`Are you sure you want to delete "${getFileName(key)}"?`)) {
      return;
    }

    try {
      const response = await fetch(`/api/s3/delete?key=${encodeKey(key)}`, {
        method: "DELETE",
      });

      const data = await response.json();
      if (data.error) {
        setError(data.error);
      } else {
        await fetchObjects();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete file");
    }
  };

  const closePreview = useCallback(() => {
    // Go back to current folder path
    if (currentPath) {
      window.history.pushState({}, "", `/folder/${encodeKey(currentPath)}`);
    } else {
      window.history.pushState({}, "", "/");
    }
    setPreviewFile(null);
    setPreviewContent("");
    setPreviewLoading(false);
  }, [currentPath]);

  const handlePreview = (key: string) => {
    const encoded = encodeKey(key);
    window.history.pushState({}, "", `/preview/${encoded}`);
    setPreviewFile(key);
  };

  const navigateToFolder = (path: string) => {
    if (path) {
      window.history.pushState({}, "", `/folder/${encodeKey(path)}`);
    } else {
      window.history.pushState({}, "", "/");
    }
    setCurrentPath(path);
  };

  const loadPreviewContent = useCallback(async (key: string) => {
    setPreviewLoading(true);
    setPreviewContent("");
    setError(null);
    try {
      const response = await fetch(`/api/s3/preview?key=${encodeKey(key)}`);
      if (!response.ok) {
        const data = await response.json();
        setPreviewContent(`Error: ${data.error || "Failed to preview file"}`);
        return;
      }
      const content = await response.text();
      setPreviewContent(content);
    } catch (err) {
      setPreviewContent(`Error: ${err instanceof Error ? err.message : "Failed to preview file"}`);
    } finally {
      setPreviewLoading(false);
    }
  }, []);

  // Search handlers
  const handleSearch = useCallback(async (query: string) => {
    setSearchQuery(query);

    if (!query.trim()) {
      setIsSearchMode(false);
      setSearchResults([]);
      setSearchTotalHits(0);
      return;
    }

    setIsSearchMode(true);
    setIsSearching(true);

    try {
      const response = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
      const data = await response.json();

      if (data.error) {
        setError(data.error);
        setSearchResults([]);
        setSearchTotalHits(0);
      } else {
        setSearchResults(data.hits || []);
        setSearchTotalHits(data.totalHits || 0);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed");
      setSearchResults([]);
      setSearchTotalHits(0);
    } finally {
      setIsSearching(false);
    }
  }, []);

  const handleClearSearch = useCallback(() => {
    setSearchQuery("");
    setSearchResults([]);
    setSearchTotalHits(0);
    setIsSearchMode(false);
  }, []);

  const handleNavigateToFolderFromSearch = useCallback((path: string) => {
    handleClearSearch();
    navigateToFolder(path);
  }, [handleClearSearch]);

  // Handle browser back/forward
  useEffect(() => {
    const handlePopState = () => {
      const previewKey = getPreviewKeyFromURL();
      if (previewKey) {
        setPreviewFile(previewKey);
      } else {
        setPreviewFile(null);
        setPreviewContent("");
        setCurrentPath(getFolderPathFromURL());
      }
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  // Load content when preview file changes
  useEffect(() => {
    if (previewFile) {
      loadPreviewContent(previewFile);
    }
  }, [previewFile, loadPreviewContent]);

  // Get items at current path
  const { folders, files } = getItemsAtPath(objects, currentPath);

  // Build breadcrumb segments
  const pathSegments = currentPath ? currentPath.split("/") : [];

  // Get file name from full key
  const getFileName = (key: string): string => {
    return key.split("/").pop() || key;
  };

  // Full-screen preview view
  if (previewFile) {
    return (
      <div className="fixed inset-0 bg-background z-50 flex flex-col">
        <div className="flex items-center gap-3 p-4 border-b bg-background">
          <Button variant="ghost" size="sm" onClick={closePreview} className="gap-2">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="m15 18-6-6 6-6"/>
            </svg>
            Back
          </Button>
          <h1 className="text-sm font-medium truncate flex-1">{previewFile}</h1>
        </div>
        <div className="flex-1 overflow-auto p-6">
          {previewLoading ? (
            <div className="text-center text-muted-foreground py-8">
              Loading...
            </div>
          ) : isMarkdown(previewFile) ? (
            <div className="prose prose-neutral dark:prose-invert max-w-4xl mx-auto prose-ul:list-disc prose-ol:list-decimal prose-li:my-1">
              <Markdown>{previewContent}</Markdown>
            </div>
          ) : (
            <pre className="font-mono text-sm whitespace-pre-wrap break-words max-w-4xl mx-auto">
              {previewContent}
            </pre>
          )}
        </div>
      </div>
    );
  }

  return (
    <Card className="w-full">
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>Markdown Viewer</CardTitle>
            <CardDescription>Browse and view markdown or text files</CardDescription>
          </div>
          <Button onClick={fetchObjects} disabled={loading} variant="outline" size="sm">
            {loading ? "Loading..." : "Refresh"}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && (
          <div className="p-3 text-sm text-red-600 bg-red-50 rounded-md dark:bg-red-900/20 dark:text-red-400">
            {error}
          </div>
        )}

        {/* Search Bar */}
        <SearchBar
          onSearch={handleSearch}
          onClear={handleClearSearch}
          isSearching={isSearching}
          initialQuery={searchQuery}
        />

        {/* Search Results */}
        {isSearchMode ? (
          <SearchResults
            hits={searchResults}
            query={searchQuery}
            totalHits={searchTotalHits}
            onPreview={handlePreview}
            onDownload={handleDownload}
            onNavigateToFolder={handleNavigateToFolderFromSearch}
          />
        ) : (
          <>
        {/* Breadcrumb Navigation */}
        <div className="flex items-center gap-1 text-sm flex-wrap">
          <button
            onClick={() => navigateToFolder("")}
            className="hover:text-primary hover:underline"
          >
            (root)
          </button>
          {pathSegments.map((segment, index) => {
            const pathToHere = pathSegments.slice(0, index + 1).join("/");
            return (
              <span key={pathToHere} className="flex items-center gap-1">
                <span className="text-muted-foreground">&gt;</span>
                <button
                  onClick={() => navigateToFolder(pathToHere)}
                  className="hover:text-primary hover:underline max-w-[200px] truncate"
                  title={segment}
                >
                  {segment}
                </button>
              </span>
            );
          })}
        </div>

        {/* File List */}
        <div className="border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="text-left p-3 font-medium">Name</th>
                <th className="text-right p-3 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {/* Parent folder navigation */}
              {currentPath && (
                <tr 
                  className="border-t hover:bg-muted/30 cursor-pointer"
                  onClick={() => {
                    const parentPath = currentPath.split("/").slice(0, -1).join("/");
                    navigateToFolder(parentPath);
                  }}
                >
                  <td className="p-3">
                    <div className="flex items-center gap-2">
                      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                      </svg>
                      <span>..</span>
                    </div>
                  </td>
                  <td 
                    className="p-3 text-right"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        const parentPath = currentPath.split("/").slice(0, -1).join("/");
                        navigateToFolder(parentPath);
                      }}
                    >
                      Back
                    </Button>
                  </td>
                </tr>
              )}

              {/* Folders */}
              {folders.map((folder) => (
                <tr 
                  key={folder} 
                  className="border-t hover:bg-muted/30 cursor-pointer"
                  onClick={() => navigateToFolder(currentPath ? `${currentPath}/${folder}` : folder)}
                >
                  <td className="p-3">
                    <div className="flex items-center gap-2">
                      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                      </svg>
                      <span className="break-all">{folder}</span>
                    </div>
                  </td>
                  <td className="p-3 text-right text-muted-foreground">
                    -
                  </td>
                </tr>
              ))}

              {/* Files */}
              {files.map((obj) => (
                <tr 
                  key={obj.key} 
                  className={`border-t hover:bg-muted/30 ${isPreviewable(obj.key) ? 'cursor-pointer' : ''}`}
                  onClick={() => {
                    if (isPreviewable(obj.key)) {
                      handlePreview(obj.key);
                    }
                  }}
                >
                  <td className="p-3">
                    <div className="flex items-center gap-2">
                      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/>
                        <polyline points="14 2 14 8 20 8"/>
                      </svg>
                      <span className="break-all">{getFileName(obj.key)}</span>
                      <span className="text-muted-foreground text-xs whitespace-nowrap">
                        ({formatBytes(obj.size)})
                      </span>
                    </div>
                  </td>
                  <td 
                    className="p-3 text-right space-x-2"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {isPreviewable(obj.key) && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handlePreview(obj.key)}
                      >
                        Preview
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => handleDownload(obj.key)}
                    >
                      Download
                    </Button>
                    <Button
                      size="sm"
                      variant="destructive"
                      onClick={() => handleDelete(obj.key)}
                    >
                      Delete
                    </Button>
                  </td>
                </tr>
              ))}

              {/* Empty state */}
              {folders.length === 0 && files.length === 0 && !currentPath && (
                <tr>
                  <td colSpan={2} className="p-6 text-center text-muted-foreground">
                    {loading ? "Loading..." : "No files in bucket"}
                  </td>
                </tr>
              )}
              {folders.length === 0 && files.length === 0 && currentPath && (
                <tr>
                  <td colSpan={2} className="p-6 text-center text-muted-foreground">
                    {loading ? "Loading..." : "This folder is empty"}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

export default S3FileManager;
