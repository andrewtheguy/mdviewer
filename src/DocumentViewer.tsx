import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import Markdown from "react-markdown";
import { SearchBar } from "@/components/SearchBar";
import { SearchResults, type SearchHit } from "@/components/SearchResults";
import { RecentFiles, type RecentFile, type FileTypeFilter } from "@/components/RecentFiles";
import { Pagination } from "@/components/Pagination";
import { Eye, Download, FileText, Folder, ChevronLeft, Loader2, House, Clock, RotateCw, RefreshCw, FolderOpen } from "lucide-react";

// Encode key as base64 URL-safe
function encodeKey(key: string): string {
  const utf8Bytes = new TextEncoder().encode(key);
  const binaryStr = Array.from(utf8Bytes, (byte) => String.fromCharCode(byte)).join("");
  const base64 = btoa(binaryStr);
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

interface DocumentItem {
  key: string;
  size: number;
  lastModified: string | null;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 Bytes";

  // Handle negative values
  const sign = bytes < 0 ? "-" : "";
  const absBytes = Math.abs(bytes);

  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB"];

  // For fractions < 1, Math.log would be negative, so force i = 0
  // For very large values, clamp i to avoid indexing past sizes array
  let i: number;
  if (absBytes < 1) {
    i = 0;
  } else {
    i = Math.min(
      Math.floor(Math.log(absBytes) / Math.log(k)),
      sizes.length - 1
    );
  }

  const value = parseFloat((absBytes / Math.pow(k, i)).toFixed(2));
  return sign + value + " " + sizes[i];
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

// Get search query from URL
function getSearchQueryFromURL(): string {
  const params = new URLSearchParams(window.location.search);
  return params.get("q") || "";
}

// Check if URL is /recent
function isRecentViewFromURL(): boolean {
  return window.location.pathname === "/recent";
}

// Get page number from URL query params
function getPageFromURL(): number {
  const params = new URLSearchParams(window.location.search);
  const pageStr = params.get("page");
  if (!pageStr) return 1;
  const page = parseInt(pageStr, 10);
  return Number.isNaN(page) || page < 1 ? 1 : page;
}

// Get preview key from URL
function getPreviewKeyFromURL(): string | null {
  const match = window.location.pathname.match(/^\/preview\/(.+)$/);
  if (match && match[1]) {
    try {
      return decodeKey(match[1]);
    } catch {
      return null;
    }
  }
  return null;
}

const PAGE_SIZE = 50;

export function DocumentViewer() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewContent, setPreviewContent] = useState<string>("");
  const [previewLoading, setPreviewLoading] = useState(false);
  const [currentPath, setCurrentPath] = useState<string>(getFolderPathFromURL);

  // Browse view state
  const [folders, setFolders] = useState<string[]>([]);
  const [files, setFiles] = useState<DocumentItem[]>([]);
  const [totalFiles, setTotalFiles] = useState(0);
  const [browseCurrentPage, setBrowseCurrentPage] = useState(1);

  const [previewFile, setPreviewFile] = useState<string | null>(getPreviewKeyFromURL);

  // Search state
  const initialSearchQuery = getSearchQueryFromURL();
  const [searchQuery, setSearchQuery] = useState(initialSearchQuery);
  const [searchResults, setSearchResults] = useState<SearchHit[]>([]);
  const [searchTotalHits, setSearchTotalHits] = useState(0);
  const [isSearching, setIsSearching] = useState(false);
  const [isSearchMode, setIsSearchMode] = useState(!!initialSearchQuery);
  const [searchCurrentPage, setSearchCurrentPage] = useState(1);

  // Reindex state
  const [isReindexing, setIsReindexing] = useState(false);

  // Recent files state
  const [isRecentMode, setIsRecentMode] = useState(isRecentViewFromURL);
  const [recentFiles, setRecentFiles] = useState<RecentFile[]>([]);
  const [recentTotalFiles, setRecentTotalFiles] = useState(0);
  const [isLoadingRecent, setIsLoadingRecent] = useState(false);
  const [recentTypeFilter, setRecentTypeFilter] = useState<FileTypeFilter>("all");
  const [recentCurrentPage, setRecentCurrentPage] = useState(1);

  // Check reindex status on mount and poll while reindexing
  useEffect(() => {
    const checkStatus = async () => {
      try {
        const response = await fetch("/api/search/reindex/status");
        const data = await response.json();
        setIsReindexing(data.running);
      } catch {
        // Ignore errors
      }
    };

    checkStatus();

    // Poll while reindexing
    if (isReindexing) {
      const interval = setInterval(checkStatus, 2000);
      return () => clearInterval(interval);
    }
  }, [isReindexing]);

  const isPreviewable = (key: string): boolean => {
    const ext = key.toLowerCase().split(".").pop();
    return ext === "txt" || ext === "md";
  };

  const isMarkdown = (key: string): boolean => {
    return key.toLowerCase().endsWith(".md");
  };

  // Fetch folder contents from API
  const fetchFolder = useCallback(async (path: string, page = 1) => {
    setLoading(true);
    setError(null);
    try {
      const offset = (page - 1) * PAGE_SIZE;
      const response = await fetch(
        `/api/documents/browse?path=${encodeURIComponent(path)}&limit=${PAGE_SIZE}&offset=${offset}`
      );
      const data = await response.json();
      if (data.error) {
        setError(data.error);
        setFolders([]);
        setFiles([]);
        setTotalFiles(0);
        setBrowseCurrentPage(1);
      } else {
        setFolders(data.folders || []);
        setFiles(data.files || []);
        setTotalFiles(data.totalFiles || 0);
        setBrowseCurrentPage(page);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch folder");
      setFolders([]);
      setFiles([]);
      setTotalFiles(0);
      setBrowseCurrentPage(1);
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial load and when path changes
  useEffect(() => {
    if (!isSearchMode && !isRecentMode) {
      fetchFolder(currentPath, 1);
    }
  }, [currentPath, isSearchMode, isRecentMode, fetchFolder]);

  const handleBrowsePageChange = useCallback((page: number) => {
    fetchFolder(currentPath, page);
  }, [currentPath, fetchFolder]);

  const handleReindex = useCallback(async () => {
    setError(null);
    try {
      const response = await fetch("/api/search/reindex", { method: "POST" });
      const data = await response.json();

      if (!response.ok) {
        setError(data.error || `Reindex failed with status ${response.status}`);
        return;
      }

      // Started successfully - polling will track progress
      setIsReindexing(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to reindex");
    }
  }, []);

  const handleRefresh = useCallback(() => {
    fetchFolder(currentPath, 1);
  }, [currentPath, fetchFolder]);

  const handleDownload = async (key: string) => {
    try {
      const response = await fetch(`/api/documents/download?key=${encodeKey(key)}`);
      if (!response.ok) {
        let errorMessage = "Failed to download file";
        try {
          const bodyText = await response.text();
          try {
            const data = JSON.parse(bodyText);
            errorMessage = data.error || bodyText || response.statusText || errorMessage;
          } catch {
            errorMessage = bodyText || response.statusText || errorMessage;
          }
        } catch {
          errorMessage = response.statusText || errorMessage;
        }
        setError(errorMessage);
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

  const navigateToFolder = useCallback((path: string) => {
    if (path) {
      window.history.pushState({}, "", `/folder/${encodeKey(path)}`);
    } else {
      window.history.pushState({}, "", "/");
    }
    setCurrentPath(path);
    // Reset browse pagination
    setBrowseCurrentPage(1);
  }, []);

  const handleNavigateUp = useCallback(() => {
    const parentPath = currentPath.split("/").slice(0, -1).join("/");
    navigateToFolder(parentPath);
  }, [currentPath, navigateToFolder]);

  const loadPreviewContent = useCallback(async (key: string) => {
    setPreviewLoading(true);
    setPreviewContent("");
    setError(null);
    try {
      const response = await fetch(`/api/documents/preview?key=${encodeKey(key)}`);
      if (!response.ok) {
        let errorMessage = "Failed to preview file";
        try {
          const bodyText = await response.text();
          try {
            const data = JSON.parse(bodyText);
            errorMessage = data.error || bodyText || response.statusText || errorMessage;
          } catch {
            errorMessage = bodyText || response.statusText || errorMessage;
          }
        } catch {
          errorMessage = response.statusText || errorMessage;
        }
        setPreviewContent(`Error: ${errorMessage}`);
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
  const performSearch = useCallback(async (query: string, page = 1) => {
    setIsSearching(true);

    try {
      const offset = (page - 1) * PAGE_SIZE;
      const response = await fetch(
        `/api/search?q=${encodeURIComponent(query)}&limit=${PAGE_SIZE}&offset=${offset}`
      );
      const data = await response.json();

      if (data.error) {
        setError(data.error);
        setSearchResults([]);
        setSearchTotalHits(0);
      } else {
        setSearchResults(data.hits || []);
        setSearchTotalHits(data.totalHits || 0);
        setSearchCurrentPage(page);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed");
      setSearchResults([]);
      setSearchTotalHits(0);
      setSearchCurrentPage(1);
    } finally {
      setIsSearching(false);
    }
  }, []);

  const handleSearch = useCallback(async (query: string, updateUrl = true) => {
    setSearchQuery(query);

    if (!query.trim()) {
      setIsSearchMode(false);
      setSearchResults([]);
      setSearchTotalHits(0);
      setSearchCurrentPage(1);
      if (updateUrl) {
        const url = new URL(window.location.href);
        url.searchParams.delete("q");
        window.history.pushState({}, "", url.pathname);
      }
      return;
    }

    // Update URL with search query
    if (updateUrl) {
      const url = new URL(window.location.href);
      url.searchParams.set("q", query);
      window.history.pushState({}, "", `${url.pathname}${url.search}`);
    }

    setIsSearchMode(true);
    setSearchCurrentPage(1);
    performSearch(query, 1);
  }, [performSearch]);

  const handleSearchPageChange = useCallback((page: number) => {
    performSearch(searchQuery, page);
  }, [searchQuery, performSearch]);

  const handleClearSearch = useCallback(() => {
    setSearchQuery("");
    setSearchResults([]);
    setSearchTotalHits(0);
    setSearchCurrentPage(1);
    setIsSearchMode(false);
    // Clear URL query param
    const url = new URL(window.location.href);
    url.searchParams.delete("q");
    window.history.pushState({}, "", url.pathname);
  }, []);

  const handleNavigateToFolderFromSearch = useCallback((path: string) => {
    handleClearSearch();
    navigateToFolder(path);
  }, [handleClearSearch, navigateToFolder]);

  // Recent files handlers
  const loadRecentFiles = useCallback(async (typeFilter: FileTypeFilter = "all", page = 1) => {
    setIsLoadingRecent(true);
    try {
      const offset = (page - 1) * PAGE_SIZE;
      const response = await fetch(
        `/api/documents/recent?limit=${PAGE_SIZE}&offset=${offset}&type=${typeFilter}`
      );
      const data = await response.json();
      if (data.error) {
        setError(data.error);
        setRecentFiles([]);
        setRecentTotalFiles(0);
      } else {
        setRecentFiles(data.files || []);
        setRecentTotalFiles(data.totalFiles || 0);
        setRecentCurrentPage(page);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load recent files");
      setRecentFiles([]);
      setRecentTotalFiles(0);
      setRecentCurrentPage(1);
    } finally {
      setIsLoadingRecent(false);
    }
  }, []);

  const handleRecentPageChange = useCallback((page: number) => {
    const url = new URL(window.location.href);
    if (page === 1) {
      url.searchParams.delete("page");
    } else {
      url.searchParams.set("page", String(page));
    }
    window.history.pushState({}, "", `${url.pathname}${url.search}`);
    loadRecentFiles(recentTypeFilter, page);
  }, [recentTypeFilter, loadRecentFiles]);

  const handleShowRecent = useCallback(() => {
    window.history.pushState({}, "", "/recent");
    setIsRecentMode(true);
    setIsSearchMode(false);
    setSearchQuery("");
    // Start at page 1 when entering recent mode fresh
    setRecentCurrentPage(1);
    loadRecentFiles(recentTypeFilter, 1);
  }, [loadRecentFiles, recentTypeFilter]);

  const handleRecentTypeFilterChange = useCallback((filter: FileTypeFilter) => {
    // Reset to page 1 and clear page from URL when filter changes
    const url = new URL(window.location.href);
    url.searchParams.delete("page");
    window.history.replaceState({}, "", `${url.pathname}${url.search}`);
    setRecentTypeFilter(filter);
    setRecentCurrentPage(1);
    loadRecentFiles(filter, 1);
  }, [loadRecentFiles]);

  const handleCloseRecent = useCallback(() => {
    setIsRecentMode(false);
    if (currentPath) {
      window.history.pushState({}, "", `/folder/${encodeKey(currentPath)}`);
    } else {
      window.history.pushState({}, "", "/");
    }
  }, [currentPath]);

  const handleNavigateToFolderFromRecent = useCallback((path: string) => {
    setIsRecentMode(false);
    navigateToFolder(path);
  }, [navigateToFolder]);

  // Trigger search on initial load if query in URL, or load recent files if on /recent
  // This should only run once on mount - handleSearch and loadRecentFiles are stable enough
  // for this purpose since we pass explicit values rather than relying on closure state
  useEffect(() => {
    const initialQuery = getSearchQueryFromURL();
    if (initialQuery) {
      handleSearch(initialQuery, false);
    } else if (isRecentViewFromURL()) {
      // Use "all" directly since this is the initial mount and recentTypeFilter starts as "all"
      // Read page from URL to support direct links to specific pages
      const pageFromUrl = getPageFromURL();
      setRecentCurrentPage(pageFromUrl);
      loadRecentFiles("all", pageFromUrl);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Handle browser back/forward
  useEffect(() => {
    const handlePopState = () => {
      const previewKey = getPreviewKeyFromURL();
      const urlQuery = getSearchQueryFromURL();
      const isRecent = isRecentViewFromURL();

      if (previewKey) {
        setPreviewFile(previewKey);
        setIsRecentMode(false);
      } else if (isRecent) {
        setPreviewFile(null);
        setPreviewContent("");
        setIsRecentMode(true);
        setIsSearchMode(false);
        const pageFromUrl = getPageFromURL();
        setRecentCurrentPage(pageFromUrl);
        loadRecentFiles(recentTypeFilter, pageFromUrl);
      } else {
        setPreviewFile(null);
        setPreviewContent("");
        const newPath = getFolderPathFromURL();
        setCurrentPath(newPath);
        setBrowseCurrentPage(1);
        setIsRecentMode(false);
      }

      // Handle search query changes from back/forward
      if (urlQuery !== searchQuery) {
        if (urlQuery) {
          handleSearch(urlQuery, false);
        } else if (!isRecent) {
          setSearchQuery("");
          setSearchResults([]);
          setSearchTotalHits(0);
          setSearchCurrentPage(1);
          setIsSearchMode(false);
        }
      }
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [searchQuery, handleSearch, loadRecentFiles, recentTypeFilter]);

  // Load content when preview file changes
  useEffect(() => {
    if (previewFile) {
      loadPreviewContent(previewFile);
    }
  }, [previewFile, loadPreviewContent]);

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
            <ChevronLeft className="size-4" />
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
    <Card className="w-full border-0 sm:border shadow-none sm:shadow-sm">
      <CardHeader className="px-4 pb-4 sm:px-6">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <CardTitle className="text-xl sm:text-2xl">Markdown Viewer</CardTitle>
            <CardDescription>Browse and view markdown or text files</CardDescription>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Button
              onClick={handleReindex}
              disabled={isReindexing}
              variant="outline"
              size="sm"
              className="gap-2"
            >
               {isReindexing ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <RotateCw className="size-4" />
              )}
              <span>{isReindexing ? "Reindexing..." : "Reindex"}</span>
            </Button>

             <Button
              onClick={handleRefresh}
              disabled={loading}
              variant="outline"
              size="sm"
              className="gap-2"
            >
              <RefreshCw className={`size-4 ${loading ? "animate-spin" : ""}`} />
              <span>Refresh</span>
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-0 sm:p-6 pt-0 sm:pt-0 space-y-4">
        {error && (
          <div className="mx-4 sm:mx-0 p-3 text-sm text-red-600 bg-red-50 rounded-md dark:bg-red-900/20 dark:text-red-400">
            {error}
          </div>
        )}

        <div className="px-4 sm:px-0 flex flex-col gap-3">
           {/* Actions Toolbar */}
          <div className="flex flex-wrap items-center gap-2 border-b pb-3">
             <Button
              variant={!isRecentMode && !isSearchMode ? "secondary" : "ghost"}
              size="sm"
              onClick={() => {
                if (isRecentMode || isSearchMode) {
                  setIsRecentMode(false);
                  setIsSearchMode(false);
                  // Switch mode: restore URL to currentPath
                  if (currentPath) {
                     window.history.pushState({}, "", `/folder/${encodeKey(currentPath)}`);
                  } else {
                     window.history.pushState({}, "", "/");
                  }
                }
              }}
              className="gap-2 h-8"
            >
              <FolderOpen className="size-4" />
              <span>Browse</span>
            </Button>

            <Button
              variant={isRecentMode ? "secondary" : "ghost"}
              size="sm"
              onClick={handleShowRecent}
              className="gap-2 h-8"
            >
              <Clock className="size-4" />
              <span>Recent</span>
            </Button>
          </div>

          {/* Search Bar */}
          <SearchBar
            onSearch={handleSearch}
            onClear={handleClearSearch}
            isSearching={isSearching}
            initialQuery={searchQuery}
          />
        </div>

        <div className="px-4 sm:px-0">
        {/* Search Results */}
        {isSearchMode ? (
          <SearchResults
            hits={searchResults}
            query={searchQuery}
            totalHits={searchTotalHits}
            onPreview={handlePreview}
            onDownload={handleDownload}
            onNavigateToFolder={handleNavigateToFolderFromSearch}
            currentPage={searchCurrentPage}
            pageSize={PAGE_SIZE}
            loading={isSearching}
            onPageChange={handleSearchPageChange}
          />
        ) : isRecentMode ? (
          <RecentFiles
            files={recentFiles}
            totalFiles={recentTotalFiles}
            loading={isLoadingRecent}
            typeFilter={recentTypeFilter}
            onTypeFilterChange={handleRecentTypeFilterChange}
            onPreview={handlePreview}
            onDownload={handleDownload}
            onNavigateToFolder={handleNavigateToFolderFromRecent}
            onClose={handleCloseRecent}
            currentPage={recentCurrentPage}
            pageSize={PAGE_SIZE}
            onPageChange={handleRecentPageChange}
          />
        ) : (
          <>
        {/* Breadcrumb Navigation */}
        <div className="flex items-center gap-1.5 text-sm flex-wrap px-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={() => navigateToFolder("")}
            title="Go to root"
          >
            <House className="size-4" />
            <span className="sr-only">Root</span>
          </Button>
          {pathSegments.map((segment, index) => {
            const pathToHere = pathSegments.slice(0, index + 1).join("/");
            return (
              <div key={pathToHere} className="flex items-center gap-1.5">
                <span className="text-muted-foreground/60">/</span>
                <button
                  type="button"
                  onClick={() => navigateToFolder(pathToHere)}
                  className="hover:text-primary hover:bg-muted/50 px-1.5 py-0.5 rounded transition-colors max-w-[150px] truncate sm:max-w-none font-medium"
                  title={segment}
                >
                  {segment}
                </button>
              </div>
            );
          })}
        </div>

        {/* File List */}
        <div className="border rounded-lg overflow-x-auto">
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
                  onClick={handleNavigateUp}
                >
                  <td className="p-3">
                    <div className="flex items-center gap-2">
                      <Folder className="size-4" />
                      <span>..</span>
                    </div>
                  </td>
                  <td className="p-3 text-right text-muted-foreground">
                    -
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
                      <Folder className="size-4" />
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
                      <FileText className="size-4 shrink-0" />
                      <span className="break-all">{getFileName(obj.key)}</span>
                      <span className="text-muted-foreground text-xs whitespace-nowrap">
                        ({formatBytes(obj.size)})
                      </span>
                    </div>
                  </td>
                  <td
                    className="p-3 text-right space-x-1 whitespace-nowrap"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {isPreviewable(obj.key) && (
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-8 w-8"
                        onClick={() => handlePreview(obj.key)}
                        title="Preview"
                      >
                        <Eye className="size-4" />
                      </Button>
                    )}
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-8 w-8"
                      onClick={() => handleDownload(obj.key)}
                      title="Download"
                    >
                      <Download className="size-4" />
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

        {/* Pagination for files */}
        {totalFiles > 0 && (
          <Pagination
            currentPage={browseCurrentPage}
            totalPages={Math.ceil(totalFiles / PAGE_SIZE)}
            totalItems={totalFiles}
            pageSize={PAGE_SIZE}
            loading={loading}
            onPageChange={handleBrowsePageChange}
          />
        )}
          </>
        )}
        </div>
      </CardContent>
    </Card>
  );
}

export default DocumentViewer;
