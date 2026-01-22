import { useState, useCallback } from "react";
import { PAGE_SIZE, getSearchQueryFromURL } from "./utils";

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

export interface UseSearchReturn {
  searchQuery: string;
  searchResults: SearchHit[];
  searchTotalHits: number;
  isSearching: boolean;
  isSearchMode: boolean;
  searchCurrentPage: number;
  handleSearch: (query: string, updateUrl?: boolean) => void;
  handleSearchPageChange: (page: number) => void;
  handleClearSearch: () => void;
  setError: (error: string | null) => void;
  restoreSearchFromURL: (searchCallback: (query: string) => void) => void;
  clearSearchState: () => void;
}

export function useSearch(onError: (error: string | null) => void): UseSearchReturn {
  const initialSearchQuery = getSearchQueryFromURL();
  const [searchQuery, setSearchQuery] = useState(initialSearchQuery);
  const [searchResults, setSearchResults] = useState<SearchHit[]>([]);
  const [searchTotalHits, setSearchTotalHits] = useState(0);
  const [isSearching, setIsSearching] = useState(false);
  const [isSearchMode, setIsSearchMode] = useState(!!initialSearchQuery);
  const [searchCurrentPage, setSearchCurrentPage] = useState(1);

  const performSearch = useCallback(async (query: string, page = 1) => {
    setIsSearching(true);

    try {
      const offset = (page - 1) * PAGE_SIZE;
      const response = await fetch(
        `/api/search?q=${encodeURIComponent(query)}&limit=${PAGE_SIZE}&offset=${offset}`
      );
      const data = await response.json();

      if (data.error) {
        onError(data.error);
        setSearchResults([]);
        setSearchTotalHits(0);
      } else {
        setSearchResults(data.hits || []);
        setSearchTotalHits(data.totalHits || 0);
        setSearchCurrentPage(page);
      }
    } catch (err) {
      onError(err instanceof Error ? err.message : "Search failed");
      setSearchResults([]);
      setSearchTotalHits(0);
      setSearchCurrentPage(1);
    } finally {
      setIsSearching(false);
    }
  }, [onError]);

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

  const restoreSearchFromURL = useCallback((searchCallback: (query: string) => void) => {
    const urlQuery = getSearchQueryFromURL();
    if (urlQuery) {
      searchCallback(urlQuery);
    }
  }, []);

  const clearSearchState = useCallback(() => {
    setSearchQuery("");
    setSearchResults([]);
    setSearchTotalHits(0);
    setSearchCurrentPage(1);
    setIsSearchMode(false);
  }, []);

  return {
    searchQuery,
    searchResults,
    searchTotalHits,
    isSearching,
    isSearchMode,
    searchCurrentPage,
    handleSearch,
    handleSearchPageChange,
    handleClearSearch,
    setError: onError,
    restoreSearchFromURL,
    clearSearchState,
  };
}
