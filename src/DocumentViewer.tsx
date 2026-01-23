import { useState, useEffect, useLayoutEffect, useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import Markdown from "react-markdown";
import { SearchBar } from "@/components/SearchBar";
import { SearchResults } from "@/components/SearchResults";
import { RecentFiles } from "@/components/RecentFiles";
import { CollectionsView } from "@/components/CollectionsView";
import { Loader2, Clock, RotateCw, Library, X } from "lucide-react";
import {
  usePreview,
  useSearch,
  useRecent,
  useCollections,
  PAGE_SIZE,
  encodeKey,
  getSearchQueryFromURL,
  isRecentViewFromURL,
  isCollectionsViewFromURL,
  shouldRedirectToCollections,
  getCollectionFromURL,
  getTitleFromURL,
  getPageFromURL,
  getTypeFilterFromURL,
} from "@/hooks";

export function DocumentViewer() {
  const [error, setError] = useState<string | null>(null);

  // Reindex state
  const [isReindexing, setIsReindexing] = useState(false);

  // Use custom hooks for state management
  const preview = usePreview();
  const search = useSearch(setError);
  const recent = useRecent(setError);
  const collections = useCollections(setError);

  // Refs to store latest hook methods for stable callbacks
  // This prevents callbacks from being recreated on every hook state change
  const restoreStateMethodsRef = useRef<{
    restorePreviewFromURL: typeof preview.restorePreviewFromURL;
    setIsRecentMode: typeof recent.setIsRecentMode;
    clearSearchState: typeof search.clearSearchState;
    restoreCollectionsFromURL: typeof collections.restoreCollectionsFromURL;
    restoreRecentFromURL: typeof recent.restoreRecentFromURL;
    handleSearch: typeof search.handleSearch;
    loadRecentFiles: typeof recent.loadRecentFiles;
    setSelectedCollection: typeof collections.setSelectedCollection;
    setSelectedTitle: typeof collections.setSelectedTitle;
    loadCollectionTranscripts: typeof collections.loadCollectionTranscripts;
    loadCollectionTitles: typeof collections.loadCollectionTitles;
    loadCollections: typeof collections.loadCollections;
  } | undefined>(undefined);

  // Synchronously update refs after render (useLayoutEffect runs before browser paint)
  useLayoutEffect(() => {
    restoreStateMethodsRef.current = {
      restorePreviewFromURL: preview.restorePreviewFromURL,
      setIsRecentMode: recent.setIsRecentMode,
      clearSearchState: search.clearSearchState,
      restoreCollectionsFromURL: collections.restoreCollectionsFromURL,
      restoreRecentFromURL: recent.restoreRecentFromURL,
      handleSearch: search.handleSearch,
      loadRecentFiles: recent.loadRecentFiles,
      setSelectedCollection: collections.setSelectedCollection,
      setSelectedTitle: collections.setSelectedTitle,
      loadCollectionTranscripts: collections.loadCollectionTranscripts,
      loadCollectionTitles: collections.loadCollectionTitles,
      loadCollections: collections.loadCollections,
    };
  });

  // Track previous reindexing state to detect completion
  const wasReindexingRef = useRef(false);
  // Ref to store restoreStateFromURL for use in polling effect
  const restoreStateFromURLRef = useRef<(() => void) | null>(null);
  // Track consecutive status check failures for debugging
  const consecutiveStatusFailuresRef = useRef(0);

  const isMarkdown = (key: string): boolean => {
    return key.toLowerCase().endsWith(".md");
  };

  const handleReindex = useCallback(async () => {
    // Ask for confirmation
    const confirmed = window.confirm(
      "This will rebuild the search index from S3. The application will be unavailable during this process. Continue?"
    );
    if (!confirmed) return;

    setError(null);
    setIsReindexing(true);
    wasReindexingRef.current = true;
    try {
      const response = await fetch("/api/search/reindex", { method: "POST" });
      const data = await response.json();

      if (!response.ok) {
        setError(data.error || `Reindex failed with status ${response.status}`);
        setIsReindexing(false);
        wasReindexingRef.current = false;
        return;
      }
      // Started successfully - polling will track progress
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to reindex");
      setIsReindexing(false);
      wasReindexingRef.current = false;
    }
  }, []);

  const handleDownload = useCallback(async (key: string) => {
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
  }, []);

  // Coordinated handlers that manage multiple hooks and close preview
  const handleShowCollections = useCallback(() => {
    preview.closePreview();
    recent.setIsRecentMode(false);
    search.clearSearchState();
    collections.handleShowCollections();
  }, [preview, recent, search, collections]);

  const handleShowRecent = useCallback(() => {
    preview.closePreview();
    search.clearSearchState();
    recent.handleShowRecent();
  }, [preview, search, recent]);

  // Wrapped handlers that close preview when list view changes
  const handleSearch = useCallback((query: string, updateUrl?: boolean) => {
    preview.closePreview();
    search.handleSearch(query, updateUrl);
  }, [preview, search]);

  const handleClearSearch = useCallback(() => {
    preview.closePreview();
    search.handleClearSearch();
  }, [preview, search]);

  const handleSearchPageChange = useCallback((page: number) => {
    preview.closePreview();
    search.handleSearchPageChange(page);
  }, [preview, search]);

  const handleRecentPageChange = useCallback((page: number) => {
    preview.closePreview();
    recent.handleRecentPageChange(page);
  }, [preview, recent]);

  const handleRecentTypeFilterChange = useCallback((filter: "all" | "txt" | "md") => {
    preview.closePreview();
    recent.handleRecentTypeFilterChange(filter);
  }, [preview, recent]);

  const handleSelectCollection = useCallback((collection: string) => {
    preview.closePreview();
    collections.handleSelectCollection(collection);
  }, [preview, collections]);

  const handleCollectionBack = useCallback(() => {
    preview.closePreview();
    collections.handleCollectionBack();
  }, [preview, collections]);

  const handleSelectTitle = useCallback((title: string) => {
    preview.closePreview();
    collections.handleSelectTitle(title);
  }, [preview, collections]);

  const handleTitleBack = useCallback(() => {
    preview.closePreview();
    collections.handleTitleBack();
  }, [preview, collections]);

  const handleTitlesPageChange = useCallback((page: number) => {
    preview.closePreview();
    collections.handleTitlesPageChange(page);
  }, [preview, collections]);

  const handleCollectionPageChange = useCallback((page: number) => {
    preview.closePreview();
    collections.handleCollectionPageChange(page);
  }, [preview, collections]);

  const handleCollectionsListPageChange = useCallback((page: number) => {
    preview.closePreview();
    collections.handleCollectionsListPageChange(page);
  }, [preview, collections]);

  // Shared function to restore state from current URL
  // Used by popstate handler to sync state with browser navigation
  // Uses refs to avoid recreating callback on every hook state change
  const restoreStateFromURL = useCallback(() => {
    const methods = restoreStateMethodsRef.current;
    if (!methods) return;

    // Redirect root to /collections
    if (shouldRedirectToCollections()) {
      window.history.replaceState({}, "", "/collections");
    }

    // Restore preview state
    methods.restorePreviewFromURL();

    const urlQuery = getSearchQueryFromURL();
    const isRecent = isRecentViewFromURL();
    const isCollectionsView = isCollectionsViewFromURL() || shouldRedirectToCollections();

    // Restore view state (collections/recent/search)
    if (isCollectionsView) {
      methods.setIsRecentMode(false);
      methods.clearSearchState();
      methods.restoreCollectionsFromURL();
    } else if (isRecent) {
      methods.restoreRecentFromURL();
      methods.clearSearchState();
    }

    // Handle search query changes
    if (urlQuery) {
      methods.handleSearch(urlQuery, false);
    } else if (!isRecent && !isCollectionsView) {
      methods.clearSearchState();
    }
  }, []);

  // Keep ref updated for use in polling effect
  useLayoutEffect(() => {
    restoreStateFromURLRef.current = restoreStateFromURL;
  });

  // Check reindex status on mount and poll while reindexing
  useEffect(() => {
    const checkStatus = async () => {
      try {
        const response = await fetch("/api/search/reindex/status");
        const data = await response.json();
        const nowReindexing = data.running;

        // Reset failure counter on success
        consecutiveStatusFailuresRef.current = 0;

        // Detect reindex completion (was running, now not running)
        if (wasReindexingRef.current && !nowReindexing) {
          // Refresh current view after reindex completes
          restoreStateFromURLRef.current?.();
        }

        wasReindexingRef.current = nowReindexing;
        setIsReindexing(nowReindexing);
      } catch (err) {
        consecutiveStatusFailuresRef.current++;
        console.error(
          `[DocumentViewer] Status check failed (attempt ${consecutiveStatusFailuresRef.current}):`,
          err
        );
      }
    };

    checkStatus();

    // Poll while reindexing
    if (isReindexing) {
      const interval = setInterval(checkStatus, 2000);
      return () => clearInterval(interval);
    }
  }, [isReindexing]);

  // Trigger search on initial load if query in URL, or load recent files if on /recent, or load collections if on /collections
  useEffect(() => {
    const methods = restoreStateMethodsRef.current;
    if (!methods) return;

    // Redirect root to /collections
    if (shouldRedirectToCollections()) {
      window.history.replaceState({}, "", "/collections");
    }

    const initialQuery = getSearchQueryFromURL();
    if (initialQuery) {
      methods.handleSearch(initialQuery, false);
    } else if (isRecentViewFromURL()) {
      // Read page and type from URL to support direct links
      const pageFromUrl = getPageFromURL();
      const typeFromUrl = getTypeFilterFromURL();
      methods.loadRecentFiles(typeFromUrl, pageFromUrl);
    } else if (isCollectionsViewFromURL() || shouldRedirectToCollections()) {
      const collectionFromUrl = getCollectionFromURL();
      const titleFromUrl = getTitleFromURL();
      const pageFromUrl = getPageFromURL();
      if (collectionFromUrl && titleFromUrl) {
        // URL: /collections/:collection/:title - load transcripts for this title
        methods.setSelectedCollection(collectionFromUrl);
        methods.setSelectedTitle(titleFromUrl);
        methods.loadCollectionTranscripts(collectionFromUrl, titleFromUrl, pageFromUrl);
      } else if (collectionFromUrl) {
        // URL: /collections/:collection - load titles for this collection
        methods.setSelectedCollection(collectionFromUrl);
        methods.loadCollectionTitles(collectionFromUrl, pageFromUrl);
      } else {
        // URL: /collections - load collections list
        methods.loadCollections(pageFromUrl);
      }
    }
  }, []);

  // Handle browser back/forward
  useEffect(() => {
    const handlePopState = () => {
      restoreStateFromURL();
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [restoreStateFromURL]);

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

  // Show reindexing overlay when reindex is in progress
  if (isReindexing) {
    return (
      <Card className="w-full border-0 sm:border shadow-none sm:shadow-sm">
        <CardContent className="p-6">
          <div className="flex flex-col items-center justify-center py-24 gap-4">
            <Loader2 className="size-12 animate-spin text-muted-foreground" />
            <div className="text-center space-y-2">
              <h2 className="text-lg font-semibold">Reindexing in Progress</h2>
              <p className="text-sm text-muted-foreground">
                Please wait while the search index is being rebuilt...
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
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
          <Button
            onClick={handleReindex}
            variant="outline"
            size="sm"
            className="gap-2"
          >
            <RotateCw className="size-4" />
            <span>Reindex</span>
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
              variant={!recent.isRecentMode && !search.isSearchMode ? "secondary" : "ghost"}
              size="sm"
              onClick={handleShowCollections}
              className="gap-2 h-8"
            >
              <Library className="size-4" />
              <span>Collections</span>
            </Button>

            <Button
              variant={recent.isRecentMode ? "secondary" : "ghost"}
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
            isSearching={search.isSearching}
            initialQuery={search.searchQuery}
          />
        </div>

        <div className="px-0 sm:px-0">
          {preview.previewFile ? (
            // Inline preview
            <div className="border-0 sm:border rounded-none sm:rounded-lg">
              <div className="flex items-center justify-between gap-3 p-4 sm:p-4 border-b bg-muted/50">
                <div className="flex flex-col flex-1 min-w-0">
                  {preview.previewMetadata?.collection && (
                    <span className="text-xs text-muted-foreground">{preview.previewMetadata.collection}</span>
                  )}
                  {preview.previewMetadata?.title && (
                    <h2 className="text-sm font-medium truncate">{preview.previewMetadata.title}</h2>
                  )}
                  <span className="text-xs text-muted-foreground truncate">{getFileName(preview.previewFile)}</span>
                  {preview.previewMetadata?.creationDateISO && (
                    <span className="text-xs text-muted-foreground">
                      {formatPreviewDate(preview.previewMetadata.creationDateISO)}
                    </span>
                  )}
                </div>
                <Button variant="ghost" size="icon" onClick={preview.closePreview} className="size-8" aria-label="Close preview">
                  <X className="size-4" />
                </Button>
              </div>
              <div className="p-4 sm:p-6">
                {preview.previewLoading ? (
                  <div className="text-center text-muted-foreground py-8">Loading...</div>
                ) : preview.previewError ? (
                  <div className="p-3 text-sm text-red-600 bg-red-50 rounded-md dark:bg-red-900/20 dark:text-red-400">
                    {preview.previewError}
                  </div>
                ) : isMarkdown(preview.previewFile) ? (
                  <div className="prose prose-neutral dark:prose-invert max-w-none prose-ul:list-disc prose-ol:list-decimal prose-li:my-1">
                    <Markdown>{preview.previewContent}</Markdown>
                  </div>
                ) : (
                  <pre className="font-mono text-sm whitespace-pre-wrap break-words">
                    {preview.previewContent}
                  </pre>
                )}
              </div>
            </div>
          ) : search.isSearchMode ? (
            <SearchResults
              hits={search.searchResults}
              query={search.searchQuery}
              totalHits={search.searchTotalHits}
              onPreview={preview.handlePreview}
              onDownload={handleDownload}
              currentPage={search.searchCurrentPage}
              pageSize={PAGE_SIZE}
              loading={search.isSearching}
              onPageChange={handleSearchPageChange}
            />
          ) : recent.isRecentMode ? (
            <RecentFiles
              files={recent.recentFiles}
              totalFiles={recent.recentTotalFiles}
              loading={recent.isLoadingRecent}
              typeFilter={recent.recentTypeFilter}
              onTypeFilterChange={handleRecentTypeFilterChange}
              onPreview={preview.handlePreview}
              onDownload={handleDownload}
              currentPage={recent.recentCurrentPage}
              pageSize={PAGE_SIZE}
              onPageChange={handleRecentPageChange}
            />
          ) : (
            <CollectionsView
              collections={collections.collections}
              totalCollections={collections.totalCollections}
              collectionsCurrentPage={collections.collectionsListCurrentPage}
              onCollectionsPageChange={handleCollectionsListPageChange}
              selectedCollection={collections.selectedCollection}
              titles={collections.collectionTitles}
              totalTitles={collections.totalCollectionTitles}
              titlesCurrentPage={collections.titlesCurrentPage}
              onTitlesPageChange={handleTitlesPageChange}
              selectedTitle={collections.selectedTitle}
              onSelectTitle={handleSelectTitle}
              onTitleBack={handleTitleBack}
              transcripts={collections.collectionTranscripts}
              loading={collections.isLoadingCollections}
              onSelectCollection={handleSelectCollection}
              onBack={handleCollectionBack}
              onPreview={preview.handlePreview}
              onDownload={handleDownload}
              currentPage={collections.collectionCurrentPage}
              pageSize={PAGE_SIZE}
              totalTranscripts={collections.collectionTotalTranscripts}
              onPageChange={handleCollectionPageChange}
            />
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export default DocumentViewer;
