import { useState, useCallback, useRef } from "react";
import {
  PAGE_SIZE,
  isCollectionsViewFromURL,
  shouldRedirectToCollections,
  getCollectionFromURL,
  getTitleFromURL,
  getPageFromURL,
  updatePageAndSortInURL,
  getSortFromURL,
  DEFAULT_SORT,
  type SortState,
  type SortField,
  type SortOrder,
} from "./utils";

// Re-export sorting types from utils
export type { SortField, SortOrder, SortState };

export interface CollectionSummary {
  name: string;
  count: number;
  latestCreationDate: string | null;
}

export interface CollectionTitle {
  title: string; // "Untitled" for null titles
  count: number;
  latestCreationDate: string | null;
}

export interface CollectionTranscript {
  key: string;
  name: string;
  title: string | null;
  creationDate: number | null;
  creationDateISO: string | null;
  size: number;
}

export interface UseCollectionsReturn {
  // Collections list (level 1)
  collections: CollectionSummary[];
  totalCollections: number;
  collectionsListCurrentPage: number;
  selectedCollection: string | null;
  isLoadingCollections: boolean;
  // Titles (level 2)
  collectionTitles: CollectionTitle[];
  totalCollectionTitles: number;
  titlesCurrentPage: number;
  selectedTitle: string | null;
  // Transcripts (level 3)
  collectionTranscripts: CollectionTranscript[];
  collectionTotalTranscripts: number;
  collectionCurrentPage: number;
  // Sorting state
  collectionSort: SortState;
  titleSort: SortState;
  transcriptSort: SortState;
  // Actions
  loadCollections: (page?: number) => Promise<void>;
  loadCollectionTitles: (collection: string, page?: number) => Promise<void>;
  loadCollectionTranscripts: (collection: string, title: string, page?: number) => Promise<void>;
  handleShowCollections: () => void;
  handleSelectCollection: (collection: string) => void;
  handleCollectionBack: () => void;
  handleSelectTitle: (title: string) => void;
  handleTitleBack: () => void;
  handleTitlesPageChange: (page: number) => void;
  handleCollectionPageChange: (page: number) => void;
  handleCollectionsListPageChange: (page: number) => void;
  setSelectedCollection: (collection: string | null) => void;
  setSelectedTitle: (title: string | null) => void;
  restoreCollectionsFromURL: () => void;
  // Sorting actions
  setCollectionSort: (sort: SortState) => void;
  setTitleSort: (sort: SortState) => void;
  setTranscriptSort: (sort: SortState) => void;
}

export function useCollections(onError: (error: string | null) => void): UseCollectionsReturn {
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

  // Sorting state - initialize from URL for the active view level
  const [collectionSort, setCollectionSort] = useState<SortState>(() => {
    // Only use URL sort if we're at collections list level
    if (isCollectionsViewFromURL() && !getCollectionFromURL()) {
      return getSortFromURL();
    }
    return DEFAULT_SORT;
  });
  const [titleSort, setTitleSort] = useState<SortState>(() => {
    // Only use URL sort if we're at titles level
    if (isCollectionsViewFromURL() && getCollectionFromURL() && !getTitleFromURL()) {
      return getSortFromURL();
    }
    return DEFAULT_SORT;
  });
  const [transcriptSort, setTranscriptSort] = useState<SortState>(() => {
    // Only use URL sort if we're at transcripts level
    if (isCollectionsViewFromURL() && getCollectionFromURL() && getTitleFromURL()) {
      return getSortFromURL();
    }
    return DEFAULT_SORT;
  });

  // AbortController refs for request cancellation to prevent race conditions
  const collectionsAbortRef = useRef<AbortController | null>(null);
  const titlesAbortRef = useRef<AbortController | null>(null);
  const transcriptsAbortRef = useRef<AbortController | null>(null);

  const loadCollections = useCallback(async (page = 1, sort?: SortState) => {
    // Abort any in-flight request
    collectionsAbortRef.current?.abort();
    const abortController = new AbortController();
    collectionsAbortRef.current = abortController;

    setIsLoadingCollections(true);
    try {
      const offset = (page - 1) * PAGE_SIZE;
      const currentSort = sort ?? collectionSort;
      const response = await fetch(
        `/api/collections?limit=${PAGE_SIZE}&offset=${offset}&sortBy=${currentSort.sortBy}&sortOrder=${currentSort.sortOrder}`,
        { signal: abortController.signal }
      );
      if (!response.ok) {
        const errorBody = await response.text();
        onError(`Failed to load collections: ${response.status} ${errorBody || response.statusText}`);
        setCollections([]);
        setTotalCollections(0);
        return;
      }
      const data = await response.json();
      if (data.error) {
        onError(data.error);
        setCollections([]);
        setTotalCollections(0);
      } else {
        setCollections(data.collections || []);
        setTotalCollections(data.total || 0);
        setCollectionsListCurrentPage(page);
      }
    } catch (err) {
      // Ignore aborted requests
      if (err instanceof Error && err.name === "AbortError") {
        return;
      }
      onError(err instanceof Error ? err.message : "Failed to load collections");
      setCollections([]);
      setTotalCollections(0);
    } finally {
      // Only clear loading if this request wasn't aborted
      if (!abortController.signal.aborted) {
        setIsLoadingCollections(false);
      }
    }
  }, [onError, collectionSort]);

  const loadCollectionTitles = useCallback(async (collection: string, page = 1, sort?: SortState) => {
    // Abort any in-flight request
    titlesAbortRef.current?.abort();
    const abortController = new AbortController();
    titlesAbortRef.current = abortController;

    setIsLoadingCollections(true);
    try {
      const offset = (page - 1) * PAGE_SIZE;
      const currentSort = sort ?? titleSort;
      const response = await fetch(
        `/api/collections/${encodeURIComponent(collection)}?limit=${PAGE_SIZE}&offset=${offset}&sortBy=${currentSort.sortBy}&sortOrder=${currentSort.sortOrder}`,
        { signal: abortController.signal }
      );
      if (!response.ok) {
        const errorBody = await response.text();
        onError(`Failed to load collection titles: ${response.status} ${errorBody || response.statusText}`);
        setCollectionTitles([]);
        setTotalCollectionTitles(0);
        return;
      }
      const data = await response.json();
      if (data.error) {
        onError(data.error);
        setCollectionTitles([]);
        setTotalCollectionTitles(0);
      } else {
        setCollectionTitles(data.titles || []);
        setTotalCollectionTitles(data.total || 0);
        setTitlesCurrentPage(page);
      }
    } catch (err) {
      // Ignore aborted requests
      if (err instanceof Error && err.name === "AbortError") {
        return;
      }
      onError(err instanceof Error ? err.message : "Failed to load collection titles");
      setCollectionTitles([]);
      setTotalCollectionTitles(0);
    } finally {
      // Only clear loading if this request wasn't aborted
      if (!abortController.signal.aborted) {
        setIsLoadingCollections(false);
      }
    }
  }, [onError, titleSort]);

  const loadCollectionTranscripts = useCallback(async (collection: string, title: string, page = 1, sort?: SortState) => {
    // Abort any in-flight request
    transcriptsAbortRef.current?.abort();
    const abortController = new AbortController();
    transcriptsAbortRef.current = abortController;

    setIsLoadingCollections(true);
    try {
      const offset = (page - 1) * PAGE_SIZE;
      const currentSort = sort ?? transcriptSort;
      const response = await fetch(
        `/api/collections/${encodeURIComponent(collection)}/transcripts/${encodeURIComponent(title)}?limit=${PAGE_SIZE}&offset=${offset}&sortBy=${currentSort.sortBy}&sortOrder=${currentSort.sortOrder}`,
        { signal: abortController.signal }
      );
      if (!response.ok) {
        const errorBody = await response.text();
        onError(`Failed to load collection transcripts: ${response.status} ${errorBody || response.statusText}`);
        setCollectionTranscripts([]);
        setCollectionTotalTranscripts(0);
        return;
      }
      const data = await response.json();
      if (data.error) {
        onError(data.error);
        setCollectionTranscripts([]);
        setCollectionTotalTranscripts(0);
      } else {
        setCollectionTranscripts(data.transcripts || []);
        setCollectionTotalTranscripts(data.total || 0);
        setCollectionCurrentPage(page);
      }
    } catch (err) {
      // Ignore aborted requests
      if (err instanceof Error && err.name === "AbortError") {
        return;
      }
      onError(err instanceof Error ? err.message : "Failed to load collection transcripts");
      setCollectionTranscripts([]);
      setCollectionTotalTranscripts(0);
    } finally {
      // Only clear loading if this request wasn't aborted
      if (!abortController.signal.aborted) {
        setIsLoadingCollections(false);
      }
    }
  }, [onError, transcriptSort]);

  const handleShowCollections = useCallback(() => {
    window.history.pushState({}, "", "/collections");
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
    loadCollections();
  }, [loadCollections]);

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
      loadCollectionTitles(selectedCollection, 1);
    }
  }, [selectedCollection, loadCollectionTitles]);

  const handleTitlesPageChange = useCallback((page: number) => {
    if (selectedCollection) {
      updatePageAndSortInURL(page, titleSort);
      loadCollectionTitles(selectedCollection, page, titleSort);
    }
  }, [selectedCollection, loadCollectionTitles, titleSort]);

  const handleCollectionPageChange = useCallback((page: number) => {
    if (selectedCollection && selectedTitle) {
      updatePageAndSortInURL(page, transcriptSort);
      loadCollectionTranscripts(selectedCollection, selectedTitle, page, transcriptSort);
    }
  }, [selectedCollection, selectedTitle, loadCollectionTranscripts, transcriptSort]);

  const handleCollectionsListPageChange = useCallback((page: number) => {
    updatePageAndSortInURL(page, collectionSort);
    loadCollections(page, collectionSort);
  }, [loadCollections, collectionSort]);

  const restoreCollectionsFromURL = useCallback(() => {
    if (isCollectionsViewFromURL() || shouldRedirectToCollections()) {
      const collectionFromUrl = getCollectionFromURL();
      const titleFromUrl = getTitleFromURL();
      const pageFromUrl = getPageFromURL();
      const sortFromUrl = getSortFromURL();
      if (collectionFromUrl && titleFromUrl) {
        // URL: /collections/:collection/:title
        setSelectedCollection(collectionFromUrl);
        setSelectedTitle(titleFromUrl);
        setCollectionCurrentPage(pageFromUrl);
        setTranscriptSort(sortFromUrl);
        loadCollectionTranscripts(collectionFromUrl, titleFromUrl, pageFromUrl, sortFromUrl);
      } else if (collectionFromUrl) {
        // URL: /collections/:collection
        setSelectedCollection(collectionFromUrl);
        setSelectedTitle(null);
        setCollectionTranscripts([]);
        setCollectionTotalTranscripts(0);
        setTitlesCurrentPage(pageFromUrl);
        setTitleSort(sortFromUrl);
        loadCollectionTitles(collectionFromUrl, pageFromUrl, sortFromUrl);
      } else {
        // URL: /collections
        setSelectedCollection(null);
        setSelectedTitle(null);
        setCollectionTitles([]);
        setTotalCollectionTitles(0);
        setCollectionTranscripts([]);
        setCollectionTotalTranscripts(0);
        setCollectionsListCurrentPage(pageFromUrl);
        setCollectionSort(sortFromUrl);
        loadCollections(pageFromUrl, sortFromUrl);
      }
    }
  }, [loadCollections, loadCollectionTitles, loadCollectionTranscripts]);

  // Sort change handlers that reload data and update URL
  const handleCollectionSortChange = useCallback((sort: SortState) => {
    setCollectionSort(sort);
    updatePageAndSortInURL(1, sort);
    loadCollections(1, sort);
  }, [loadCollections]);

  const handleTitleSortChange = useCallback((sort: SortState) => {
    setTitleSort(sort);
    if (selectedCollection) {
      updatePageAndSortInURL(1, sort);
      loadCollectionTitles(selectedCollection, 1, sort);
    }
  }, [loadCollectionTitles, selectedCollection]);

  const handleTranscriptSortChange = useCallback((sort: SortState) => {
    setTranscriptSort(sort);
    if (selectedCollection && selectedTitle) {
      updatePageAndSortInURL(1, sort);
      loadCollectionTranscripts(selectedCollection, selectedTitle, 1, sort);
    }
  }, [loadCollectionTranscripts, selectedCollection, selectedTitle]);

  return {
    collections,
    totalCollections,
    collectionsListCurrentPage,
    selectedCollection,
    isLoadingCollections,
    collectionTitles,
    totalCollectionTitles,
    titlesCurrentPage,
    selectedTitle,
    collectionTranscripts,
    collectionTotalTranscripts,
    collectionCurrentPage,
    collectionSort,
    titleSort,
    transcriptSort,
    loadCollections,
    loadCollectionTitles,
    loadCollectionTranscripts,
    handleShowCollections,
    handleSelectCollection,
    handleCollectionBack,
    handleSelectTitle,
    handleTitleBack,
    handleTitlesPageChange,
    handleCollectionPageChange,
    handleCollectionsListPageChange,
    setSelectedCollection,
    setSelectedTitle,
    restoreCollectionsFromURL,
    setCollectionSort: handleCollectionSortChange,
    setTitleSort: handleTitleSortChange,
    setTranscriptSort: handleTranscriptSortChange,
  };
}
