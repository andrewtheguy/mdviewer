import { useState, useCallback } from "react";
import {
  PAGE_SIZE,
  isRecentViewFromURL,
  getPageFromURL,
  getTypeFilterFromURL,
} from "./utils";
import type { FileTypeFilter } from "./utils";

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

export interface UseRecentReturn {
  isRecentMode: boolean;
  recentFiles: RecentFile[];
  recentTotalFiles: number;
  isLoadingRecent: boolean;
  recentTypeFilter: FileTypeFilter;
  recentCurrentPage: number;
  loadRecentFiles: (typeFilter?: FileTypeFilter, page?: number) => Promise<void>;
  handleRecentPageChange: (page: number) => void;
  handleShowRecent: () => void;
  handleRecentTypeFilterChange: (filter: FileTypeFilter) => void;
  setIsRecentMode: (value: boolean) => void;
  restoreRecentFromURL: () => void;
}

export function useRecent(onError: (error: string | null) => void): UseRecentReturn {
  const [isRecentMode, setIsRecentMode] = useState(isRecentViewFromURL);
  const [recentFiles, setRecentFiles] = useState<RecentFile[]>([]);
  const [recentTotalFiles, setRecentTotalFiles] = useState(0);
  const [isLoadingRecent, setIsLoadingRecent] = useState(false);
  const [recentTypeFilter, setRecentTypeFilter] = useState<FileTypeFilter>("all");
  const [recentCurrentPage, setRecentCurrentPage] = useState(1);

  const loadRecentFiles = useCallback(async (typeFilter: FileTypeFilter = "all", page = 1) => {
    setIsLoadingRecent(true);
    try {
      const offset = (page - 1) * PAGE_SIZE;
      const response = await fetch(
        `/api/documents/recent?limit=${PAGE_SIZE}&offset=${offset}&type=${typeFilter}`
      );
      const data = await response.json();
      if (data.error) {
        onError(data.error);
        setRecentFiles([]);
        setRecentTotalFiles(0);
      } else {
        setRecentFiles(data.files || []);
        setRecentTotalFiles(data.totalFiles || 0);
        setRecentCurrentPage(page);
      }
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to load recent files");
      setRecentFiles([]);
      setRecentTotalFiles(0);
      setRecentCurrentPage(1);
    } finally {
      setIsLoadingRecent(false);
    }
  }, [onError]);

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

  const restoreRecentFromURL = useCallback(() => {
    if (isRecentViewFromURL()) {
      setIsRecentMode(true);
      const pageFromUrl = getPageFromURL();
      const typeFromUrl = getTypeFilterFromURL();
      setRecentCurrentPage(pageFromUrl);
      setRecentTypeFilter(typeFromUrl);
      loadRecentFiles(typeFromUrl, pageFromUrl);
    }
  }, [loadRecentFiles]);

  return {
    isRecentMode,
    recentFiles,
    recentTotalFiles,
    isLoadingRecent,
    recentTypeFilter,
    recentCurrentPage,
    loadRecentFiles,
    handleRecentPageChange,
    handleShowRecent,
    handleRecentTypeFilterChange,
    setIsRecentMode,
    restoreRecentFromURL,
  };
}
