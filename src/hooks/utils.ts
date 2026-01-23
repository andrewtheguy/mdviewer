// Shared utilities and constants for hooks

export const PAGE_SIZE = 50;

// Encode key as base64 URL-safe
export function encodeKey(key: string): string {
  const utf8Bytes = new TextEncoder().encode(key);
  const binaryStr = Array.from(utf8Bytes, (byte) => String.fromCharCode(byte)).join("");
  const base64 = btoa(binaryStr);
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Decode base64 URL-safe key
export function decodeKey(encoded: string): string {
  let base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
  while (base64.length % 4) {
    base64 += "=";
  }
  const binaryStr = atob(base64);
  const bytes = Uint8Array.from(binaryStr, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

// Get search query from URL
export function getSearchQueryFromURL(): string {
  const params = new URLSearchParams(window.location.search);
  return params.get("q") || "";
}

// Check if URL is /recent
export function isRecentViewFromURL(): boolean {
  return window.location.pathname === "/recent";
}

// Check if URL is collections view
export function isCollectionsViewFromURL(): boolean {
  const pathname = window.location.pathname;
  return pathname === "/collections" || pathname.startsWith("/collections/");
}

// Check if should redirect to /collections (when at root)
export function shouldRedirectToCollections(): boolean {
  return window.location.pathname === "/";
}

// Get selected collection from URL
// URL structure: /collections/:collection or /collections/:collection/:title
export function getCollectionFromURL(): string | null {
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
export function getTitleFromURL(): string | null {
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
export function getPageFromURL(): number {
  const params = new URLSearchParams(window.location.search);
  const pageStr = params.get("page");
  if (!pageStr) return 1;
  const page = parseInt(pageStr, 10);
  return Number.isNaN(page) || page < 1 ? 1 : page;
}

// Get type filter from URL query params
export type FileTypeFilter = "all" | "txt" | "md";

export function getTypeFilterFromURL(): FileTypeFilter {
  const params = new URLSearchParams(window.location.search);
  const type = params.get("type");
  if (type === "txt" || type === "md") {
    return type;
  }
  return "all";
}

// Get preview key from URL query param
export function getPreviewFromQueryParam(): string | null {
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

// Sort types
export type SortField = "name" | "date";
export type SortOrder = "asc" | "desc";

export interface SortState {
  sortBy: SortField;
  sortOrder: SortOrder;
}

// Default sort state
export const DEFAULT_SORT: SortState = { sortBy: "date", sortOrder: "desc" };

// Get sort state from URL query params
export function getSortFromURL(): SortState {
  const params = new URLSearchParams(window.location.search);
  const sortBy = params.get("sortBy");
  const sortOrder = params.get("sortOrder");
  return {
    sortBy: sortBy === "name" || sortBy === "date" ? sortBy : DEFAULT_SORT.sortBy,
    sortOrder: sortOrder === "asc" || sortOrder === "desc" ? sortOrder : DEFAULT_SORT.sortOrder,
  };
}

// Check if sort state is the default
function isDefaultSort(sort: SortState): boolean {
  return sort.sortBy === DEFAULT_SORT.sortBy && sort.sortOrder === DEFAULT_SORT.sortOrder;
}

// Update page and sort query params in URL and push to history
export function updatePageAndSortInURL(page: number, sort: SortState): void {
  const url = new URL(window.location.href);
  if (page === 1) {
    url.searchParams.delete("page");
  } else {
    url.searchParams.set("page", String(page));
  }
  if (isDefaultSort(sort)) {
    url.searchParams.delete("sortBy");
    url.searchParams.delete("sortOrder");
  } else {
    url.searchParams.set("sortBy", sort.sortBy);
    url.searchParams.set("sortOrder", sort.sortOrder);
  }
  window.history.pushState({}, "", `${url.pathname}${url.search}`);
}

// Update page query param in URL and push to history
export function updatePageInURL(page: number): void {
  const url = new URL(window.location.href);
  if (page === 1) {
    url.searchParams.delete("page");
  } else {
    url.searchParams.set("page", String(page));
  }
  window.history.pushState({}, "", `${url.pathname}${url.search}`);
}
