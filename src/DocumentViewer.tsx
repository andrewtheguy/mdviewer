import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import Markdown from "react-markdown";
import { SearchBar } from "@/components/SearchBar";
import { SearchResults, type SearchHit } from "@/components/SearchResults";
import { RecentFiles, type RecentFile, type FileTypeFilter } from "@/components/RecentFiles";
import { CollectionsView, type CollectionSummary, type CollectionTitle, type CollectionTranscript } from "@/components/CollectionsView";
import { Loader2, Clock, RotateCw, Library, X } from "lucide-react";

interface PreviewMetadata {
  collection: string | null;
  title: string | null;
  creationDate: number | null;
  creationDateISO: string | null;
}

// Encode key as base64 URL-safe
function encodeKey(key: string): string {
  const utf8Bytes = new TextEncoder().encode(key);
  const binaryStr = Array.from(utf8Bytes, (byte) => String.fromCharCode(byte)).join("");
  const base64 = btoa(binaryStr);
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
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

// Get search query from URL
function getSearchQueryFromURL(): string {
  const params = new URLSearchParams(window.location.search);
  return params.get("q") || "";
}

// Check if URL is /recent
function isRecentViewFromURL(): boolean {
  return window.location.pathname === "/recent";
}

// Check if URL is collections view
function isCollectionsViewFromURL(): boolean {
  const pathname = window.location.pathname;
  return pathname === "/collections" || pathname.startsWith("/collections/");
}

// Check if should redirect to /collections (when at root)
function shouldRedirectToCollections(): boolean {
  return window.location.pathname === "/";
}

// Get selected collection from URL
// URL structure: /collections/:collection or /collections/:collection/:title
function getCollectionFromURL(): string | null {
  const match = window.location.pathname.match(/^\/collections\/([^/]+)/);
  if (match && match[1]) {
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return null;
    }
  }
  return null;
}

// Get selected title from URL
// URL structure: /collections/:collection/:title
function getTitleFromURL(): string | null {
  const match = window.location.pathname.match(/^\/collections\/[^/]+\/(.+)$/);
  if (match && match[1]) {
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return null;
    }
  }
  return null;
}

// Get page number from URL query params
function getPageFromURL(): number {
  const params = new URLSearchParams(window.location.search);
  const pageStr = params.get("page");
  if (!pageStr) return 1;
  const page = parseInt(pageStr, 10);
  return Number.isNaN(page) || page < 1 ? 1 : page;
}

// Get type filter from URL query params
function getTypeFilterFromURL(): FileTypeFilter {
  const params = new URLSearchParams(window.location.search);
  const type = params.get("type");
  if (type === "txt" || type === "md") {
    return type;
  }
  return "all";
}

// Get preview key from URL query param
function getPreviewFromQueryParam(): string | null {
  const params = new URLSearchParams(window.location.search);
  const encoded = params.get("preview");
  if (encoded) {
    try {
      return decodeKey(encoded);
    } catch {
      return null;
    }
  }
  return null;
}

// Update page query param in URL and push to history
function updatePageInURL(page: number): void {
  const url = new URL(window.location.href);
  if (page === 1) {
    url.searchParams.delete("page");
  } else {
    url.searchParams.set("page", String(page));
  }
  window.history.pushState({}, "", `${url.pathname}${url.search}`);
}

const PAGE_SIZE = 50;

export function DocumentViewer() {
  const [error, setError] = useState<string | null>(null);
  const [previewContent, setPreviewContent] = useState<string>("");
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewMetadata, setPreviewMetadata] = useState<PreviewMetadata | null>(null);

  const [previewFile, setPreviewFile] = useState<string | null>(getPreviewFromQueryParam);

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

  // Collections state
  const [collections, setCollections] = useState<CollectionSummary[]>([]);
  const [totalCollections, setTotalCollections] = useState(0);
  const [collectionsListCurrentPage, setCollectionsListCurrentPage] = useState(1);
  const [selectedCollection, setSelectedCollection] = useState<string | null>(getCollectionFromURL);
  const [isLoadingCollections, setIsLoadingCollections] = useState(false);

  // Titles state (level 2)
  const [collectionTitles, setCollectionTitles] = useState<CollectionTitle[]>([]);
  const [totalCollectionTitles, setTotalCollectionTitles] = useState(0);
  const [titlesCurrentPage, setTitlesCurrentPage] = useState(1);
  const [selectedTitle, setSelectedTitle] = useState<string | null>(getTitleFromURL);

  // Transcripts state (level 3)
  const [collectionTranscripts, setCollectionTranscripts] = useState<CollectionTranscript[]>([]);
  const [collectionTotalTranscripts, setCollectionTotalTranscripts] = useState(0);
  const [collectionCurrentPage, setCollectionCurrentPage] = useState(1);

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

  const isMarkdown = (key: string): boolean => {
    return key.toLowerCase().endsWith(".md");
  };

  const handleReindex = useCallback(async () => {
    setError(null);
    setIsReindexing(true);
    try {
      const response = await fetch("/api/search/reindex", { method: "POST" });
      const data = await response.json();

      if (!response.ok) {
        setError(data.error || `Reindex failed with status ${response.status}`);
        setIsReindexing(false);
        return;
      }
      // Started successfully - polling will track progress
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to reindex");
      setIsReindexing(false);
    }
  }, []);

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

  const handlePreview = (key: string) => {
    const url = new URL(window.location.href);
    url.searchParams.set("preview", encodeKey(key));
    window.history.pushState({}, "", `${url.pathname}${url.search}`);
    setPreviewFile(key);
  };

  const loadPreviewContent = useCallback(async (key: string) => {
    setPreviewLoading(true);
    setPreviewContent("");
    setPreviewMetadata(null);
    setError(null);
    try {
      const response = await fetch(`/api/documents/preview?key=${encodeKey(key)}`);
      if (!response.ok) {
        let errorMessage = "Failed to preview file";
        try {
          const data = await response.json();
          errorMessage = data.error || response.statusText || errorMessage;
        } catch {
          errorMessage = response.statusText || errorMessage;
        }
        setPreviewContent(`Error: ${errorMessage}`);
        return;
      }
      const data = await response.json();
      setPreviewContent(data.content);
      setPreviewMetadata({
        collection: data.collection,
        title: data.title,
        creationDate: data.creationDate,
        creationDateISO: data.creationDateISO,
      });
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
    // Preserve type filter in URL
    if (recentTypeFilter === "all") {
      url.searchParams.delete("type");
    } else {
      url.searchParams.set("type", recentTypeFilter);
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
    // Reset to page 1 and update type in URL when filter changes
    const url = new URL(window.location.href);
    url.searchParams.delete("page");
    if (filter === "all") {
      url.searchParams.delete("type");
    } else {
      url.searchParams.set("type", filter);
    }
    window.history.pushState({}, "", `${url.pathname}${url.search}`);
    setRecentTypeFilter(filter);
    setRecentCurrentPage(1);
    loadRecentFiles(filter, 1);
  }, [loadRecentFiles]);

  // Collections handlers
  const loadCollections = useCallback(async (page = 1) => {
    setIsLoadingCollections(true);
    try {
      const offset = (page - 1) * PAGE_SIZE;
      const response = await fetch(`/api/collections?limit=${PAGE_SIZE}&offset=${offset}`);
      const data = await response.json();
      if (data.error) {
        setError(data.error);
        setCollections([]);
        setTotalCollections(0);
      } else {
        setCollections(data.collections || []);
        setTotalCollections(data.total || 0);
        setCollectionsListCurrentPage(page);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load collections");
      setCollections([]);
      setTotalCollections(0);
    } finally {
      setIsLoadingCollections(false);
    }
  }, []);

  const loadCollectionTitles = useCallback(async (collection: string, page = 1) => {
    setIsLoadingCollections(true);
    try {
      const offset = (page - 1) * PAGE_SIZE;
      const response = await fetch(
        `/api/collections/${encodeURIComponent(collection)}?limit=${PAGE_SIZE}&offset=${offset}`
      );
      const data = await response.json();
      if (data.error) {
        setError(data.error);
        setCollectionTitles([]);
        setTotalCollectionTitles(0);
      } else {
        setCollectionTitles(data.titles || []);
        setTotalCollectionTitles(data.total || 0);
        setTitlesCurrentPage(page);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load collection titles");
      setCollectionTitles([]);
      setTotalCollectionTitles(0);
    } finally {
      setIsLoadingCollections(false);
    }
  }, []);

  const loadCollectionTranscripts = useCallback(async (collection: string, title: string, page = 1) => {
    setIsLoadingCollections(true);
    try {
      const offset = (page - 1) * PAGE_SIZE;
      const response = await fetch(
        `/api/collections/${encodeURIComponent(collection)}/transcripts/${encodeURIComponent(title)}?limit=${PAGE_SIZE}&offset=${offset}`
      );
      const data = await response.json();
      if (data.error) {
        setError(data.error);
        setCollectionTranscripts([]);
        setCollectionTotalTranscripts(0);
      } else {
        setCollectionTranscripts(data.transcripts || []);
        setCollectionTotalTranscripts(data.total || 0);
        setCollectionCurrentPage(page);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load collection transcripts");
      setCollectionTranscripts([]);
      setCollectionTotalTranscripts(0);
    } finally {
      setIsLoadingCollections(false);
    }
  }, []);

  const handleShowCollections = useCallback(() => {
    window.history.pushState({}, "", "/collections");
    setIsRecentMode(false);
    setIsSearchMode(false);
    setSearchQuery("");
    setSelectedCollection(null);
    setSelectedTitle(null);
    setCollectionTitles([]);
    setTotalCollectionTitles(0);
    setTitlesCurrentPage(1);
    setCollectionTranscripts([]);
    setCollectionTotalTranscripts(0);
    setCollectionCurrentPage(1);
    loadCollections();
  }, [loadCollections]);

  const handleSelectCollection = useCallback((collection: string) => {
    window.history.pushState({}, "", `/collections/${encodeURIComponent(collection)}`);
    setSelectedCollection(collection);
    setSelectedTitle(null);
    setTitlesCurrentPage(1);
    loadCollectionTitles(collection, 1);
  }, [loadCollectionTitles]);

  const handleCollectionBack = useCallback(() => {
    window.history.pushState({}, "", "/collections");
    setSelectedCollection(null);
    setSelectedTitle(null);
    setCollectionTitles([]);
    setTotalCollectionTitles(0);
    setTitlesCurrentPage(1);
    setCollectionTranscripts([]);
    setCollectionTotalTranscripts(0);
    setCollectionCurrentPage(1);
  }, []);

  const handleSelectTitle = useCallback((title: string) => {
    if (selectedCollection) {
      window.history.pushState({}, "", `/collections/${encodeURIComponent(selectedCollection)}/${encodeURIComponent(title)}`);
      setSelectedTitle(title);
      setCollectionCurrentPage(1);
      loadCollectionTranscripts(selectedCollection, title, 1);
    }
  }, [selectedCollection, loadCollectionTranscripts]);

  const handleTitleBack = useCallback(() => {
    if (selectedCollection) {
      window.history.pushState({}, "", `/collections/${encodeURIComponent(selectedCollection)}`);
      setSelectedTitle(null);
      setCollectionTranscripts([]);
      setCollectionTotalTranscripts(0);
      setCollectionCurrentPage(1);
    }
  }, [selectedCollection]);

  const handleTitlesPageChange = useCallback((page: number) => {
    if (selectedCollection) {
      updatePageInURL(page);
      loadCollectionTitles(selectedCollection, page);
    }
  }, [selectedCollection, loadCollectionTitles]);

  const handleCollectionPageChange = useCallback((page: number) => {
    if (selectedCollection && selectedTitle) {
      updatePageInURL(page);
      loadCollectionTranscripts(selectedCollection, selectedTitle, page);
    }
  }, [selectedCollection, selectedTitle, loadCollectionTranscripts]);

  const handleCollectionsListPageChange = useCallback((page: number) => {
    updatePageInURL(page);
    loadCollections(page);
  }, [loadCollections]);

  // Shared function to restore state from current URL
  // Used by popstate handler to sync state with browser navigation
  const restoreStateFromURL = useCallback(() => {
    // Redirect root to /collections
    if (shouldRedirectToCollections()) {
      window.history.replaceState({}, "", "/collections");
    }

    // Check preview param (coexists with view state)
    const previewKey = getPreviewFromQueryParam();
    if (previewKey) {
      setPreviewFile(previewKey);
    } else {
      setPreviewFile(null);
      setPreviewContent("");
      setPreviewMetadata(null);
    }

    const urlQuery = getSearchQueryFromURL();
    const isRecent = isRecentViewFromURL();
    const isCollections = isCollectionsViewFromURL() || shouldRedirectToCollections();

    // Restore view state (collections/recent/search)
    if (isCollections) {
      setIsRecentMode(false);
      setIsSearchMode(false);
      const collectionFromUrl = getCollectionFromURL();
      const titleFromUrl = getTitleFromURL();
      const pageFromUrl = getPageFromURL();
      if (collectionFromUrl && titleFromUrl) {
        // URL: /collections/:collection/:title
        setSelectedCollection(collectionFromUrl);
        setSelectedTitle(titleFromUrl);
        setCollectionCurrentPage(pageFromUrl);
        loadCollectionTranscripts(collectionFromUrl, titleFromUrl, pageFromUrl);
      } else if (collectionFromUrl) {
        // URL: /collections/:collection
        setSelectedCollection(collectionFromUrl);
        setSelectedTitle(null);
        setCollectionTranscripts([]);
        setCollectionTotalTranscripts(0);
        setTitlesCurrentPage(pageFromUrl);
        loadCollectionTitles(collectionFromUrl, pageFromUrl);
      } else {
        // URL: /collections
        setSelectedCollection(null);
        setSelectedTitle(null);
        setCollectionTitles([]);
        setTotalCollectionTitles(0);
        setCollectionTranscripts([]);
        setCollectionTotalTranscripts(0);
        setCollectionsListCurrentPage(pageFromUrl);
        loadCollections(pageFromUrl);
      }
    } else if (isRecent) {
      setIsRecentMode(true);
      setIsSearchMode(false);
      const pageFromUrl = getPageFromURL();
      const typeFromUrl = getTypeFilterFromURL();
      setRecentCurrentPage(pageFromUrl);
      setRecentTypeFilter(typeFromUrl);
      loadRecentFiles(typeFromUrl, pageFromUrl);
    }

    // Handle search query changes
    if (urlQuery) {
      handleSearch(urlQuery, false);
    } else if (!isRecent && !isCollections) {
      setSearchQuery("");
      setSearchResults([]);
      setSearchTotalHits(0);
      setSearchCurrentPage(1);
      setIsSearchMode(false);
    }
  }, [handleSearch, loadRecentFiles, loadCollections, loadCollectionTitles, loadCollectionTranscripts]);

  const closePreview = useCallback(() => {
    const url = new URL(window.location.href);
    url.searchParams.delete("preview");
    window.history.pushState({}, "", `${url.pathname}${url.search}`);
    setPreviewFile(null);
    setPreviewContent("");
    setPreviewMetadata(null);
    setPreviewLoading(false);
  }, []);

  // Trigger search on initial load if query in URL, or load recent files if on /recent, or load collections if on /collections
  // This should only run once on mount - handleSearch and loadRecentFiles are stable enough
  // for this purpose since we pass explicit values rather than relying on closure state
  useEffect(() => {
    // Redirect root to /collections
    if (shouldRedirectToCollections()) {
      window.history.replaceState({}, "", "/collections");
    }

    const initialQuery = getSearchQueryFromURL();
    if (initialQuery) {
      handleSearch(initialQuery, false);
    } else if (isRecentViewFromURL()) {
      // Read page and type from URL to support direct links
      const pageFromUrl = getPageFromURL();
      const typeFromUrl = getTypeFilterFromURL();
      setRecentCurrentPage(pageFromUrl);
      setRecentTypeFilter(typeFromUrl);
      loadRecentFiles(typeFromUrl, pageFromUrl);
    } else if (isCollectionsViewFromURL() || shouldRedirectToCollections()) {
      const collectionFromUrl = getCollectionFromURL();
      const titleFromUrl = getTitleFromURL();
      const pageFromUrl = getPageFromURL();
      if (collectionFromUrl && titleFromUrl) {
        // URL: /collections/:collection/:title - load transcripts for this title
        setSelectedCollection(collectionFromUrl);
        setSelectedTitle(titleFromUrl);
        setCollectionCurrentPage(pageFromUrl);
        loadCollectionTranscripts(collectionFromUrl, titleFromUrl, pageFromUrl);
      } else if (collectionFromUrl) {
        // URL: /collections/:collection - load titles for this collection
        setSelectedCollection(collectionFromUrl);
        setTitlesCurrentPage(pageFromUrl);
        loadCollectionTitles(collectionFromUrl, pageFromUrl);
      } else {
        // URL: /collections - load collections list
        setCollectionsListCurrentPage(pageFromUrl);
        loadCollections(pageFromUrl);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Handle browser back/forward
  useEffect(() => {
    const handlePopState = () => {
      restoreStateFromURL();
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [restoreStateFromURL]);

  // Load content when preview file changes
  useEffect(() => {
    if (previewFile) {
      loadPreviewContent(previewFile);
    }
  }, [previewFile, loadPreviewContent]);

  // Get file name from full key
  const getFileName = (key: string): string => {
    return key.split("/").pop() || key;
  };

  // Format date for display
  const formatPreviewDate = (isoDate: string | null): string => {
    if (!isoDate) return "";
    try {
      return new Date(isoDate).toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      });
    } catch {
      return "";
    }
  };

  return (
    <Card className="w-full border-0 sm:border shadow-none sm:shadow-sm">
      <CardHeader className="px-4 pb-4 sm:px-6">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <CardTitle className="text-xl sm:text-2xl">Markdown Viewer</CardTitle>
            <CardDescription>Browse and view markdown or text files</CardDescription>
          </div>
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
              onClick={handleShowCollections}
              className="gap-2 h-8"
            >
              <Library className="size-4" />
              <span>Collections</span>
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
          {previewFile ? (
            // Inline preview
            <div className="border rounded-lg">
              <div className="flex items-center justify-between gap-3 p-4 border-b bg-muted/50">
                <div className="flex flex-col flex-1 min-w-0">
                  {previewMetadata?.collection && (
                    <span className="text-xs text-muted-foreground">{previewMetadata.collection}</span>
                  )}
                  {previewMetadata?.title && (
                    <h2 className="text-sm font-medium truncate">{previewMetadata.title}</h2>
                  )}
                  <span className="text-xs text-muted-foreground truncate">{getFileName(previewFile)}</span>
                  {previewMetadata?.creationDateISO && (
                    <span className="text-xs text-muted-foreground">
                      {formatPreviewDate(previewMetadata.creationDateISO)}
                    </span>
                  )}
                </div>
                <Button variant="ghost" size="icon" onClick={closePreview} className="size-8">
                  <X className="size-4" />
                </Button>
              </div>
              <div className="p-6 max-h-[70vh] overflow-auto">
                {previewLoading ? (
                  <div className="text-center text-muted-foreground py-8">Loading...</div>
                ) : isMarkdown(previewFile) ? (
                  <div className="prose prose-neutral dark:prose-invert max-w-none prose-ul:list-disc prose-ol:list-decimal prose-li:my-1">
                    <Markdown>{previewContent}</Markdown>
                  </div>
                ) : (
                  <pre className="font-mono text-sm whitespace-pre-wrap break-words">
                    {previewContent}
                  </pre>
                )}
              </div>
            </div>
          ) : isSearchMode ? (
            <SearchResults
              hits={searchResults}
              query={searchQuery}
              totalHits={searchTotalHits}
              onPreview={handlePreview}
              onDownload={handleDownload}
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
              currentPage={recentCurrentPage}
              pageSize={PAGE_SIZE}
              onPageChange={handleRecentPageChange}
            />
          ) : (
            <CollectionsView
              collections={collections}
              totalCollections={totalCollections}
              collectionsCurrentPage={collectionsListCurrentPage}
              onCollectionsPageChange={handleCollectionsListPageChange}
              selectedCollection={selectedCollection}
              titles={collectionTitles}
              totalTitles={totalCollectionTitles}
              titlesCurrentPage={titlesCurrentPage}
              onTitlesPageChange={handleTitlesPageChange}
              selectedTitle={selectedTitle}
              onSelectTitle={handleSelectTitle}
              onTitleBack={handleTitleBack}
              transcripts={collectionTranscripts}
              loading={isLoadingCollections}
              onSelectCollection={handleSelectCollection}
              onBack={handleCollectionBack}
              onPreview={handlePreview}
              onDownload={handleDownload}
              currentPage={collectionCurrentPage}
              pageSize={PAGE_SIZE}
              totalTranscripts={collectionTotalTranscripts}
              onPageChange={handleCollectionPageChange}
            />
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export default DocumentViewer;
