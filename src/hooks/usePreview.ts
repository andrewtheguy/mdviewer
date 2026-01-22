import { useState, useCallback, useEffect } from "react";
import { encodeKey, getPreviewFromQueryParam } from "./utils";

export interface PreviewMetadata {
  collection: string | null;
  title: string | null;
  creationDate: number | null;
  creationDateISO: string | null;
}

export interface UsePreviewReturn {
  previewFile: string | null;
  previewContent: string;
  previewLoading: boolean;
  previewMetadata: PreviewMetadata | null;
  previewError: string | null;
  handlePreview: (key: string) => void;
  closePreview: () => void;
  setPreviewFile: (key: string | null) => void;
  restorePreviewFromURL: () => void;
}

export function usePreview(): UsePreviewReturn {
  const [previewFile, setPreviewFile] = useState<string | null>(getPreviewFromQueryParam);
  const [previewContent, setPreviewContent] = useState<string>("");
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewMetadata, setPreviewMetadata] = useState<PreviewMetadata | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const loadPreviewContent = useCallback(async (key: string, signal?: AbortSignal) => {
    setPreviewLoading(true);
    setPreviewContent("");
    setPreviewMetadata(null);
    setPreviewError(null);
    try {
      const response = await fetch(`/api/documents/preview?key=${encodeKey(key)}`, { signal });
      if (!response.ok) {
        let errorMessage = "Failed to preview file";
        try {
          const data = await response.json();
          errorMessage = data.error || response.statusText || errorMessage;
        } catch {
          errorMessage = response.statusText || errorMessage;
        }
        setPreviewError(errorMessage);
        return;
      }
      const data = await response.json();
      setPreviewError(null);
      setPreviewContent(data.content);
      setPreviewMetadata({
        collection: data.collection,
        title: data.title,
        creationDate: data.creationDate,
        creationDateISO: data.creationDateISO,
      });
    } catch (err) {
      // Don't set error state if the request was aborted
      if (err instanceof Error && err.name === "AbortError") {
        return;
      }
      setPreviewError(err instanceof Error ? err.message : "Failed to preview file");
    } finally {
      // Don't clear loading state if aborted (a new request may be in flight)
      if (!signal?.aborted) {
        setPreviewLoading(false);
      }
    }
  }, []);

  const handlePreview = useCallback((key: string) => {
    const url = new URL(window.location.href);
    url.searchParams.set("preview", encodeKey(key));
    window.history.pushState({}, "", `${url.pathname}${url.search}`);
    setPreviewFile(key);
  }, []);

  const closePreview = useCallback(() => {
    const url = new URL(window.location.href);
    url.searchParams.delete("preview");
    window.history.pushState({}, "", `${url.pathname}${url.search}`);
    setPreviewFile(null);
    setPreviewContent("");
    setPreviewMetadata(null);
    setPreviewLoading(false);
    setPreviewError(null);
  }, []);

  const restorePreviewFromURL = useCallback(() => {
    const previewKey = getPreviewFromQueryParam();
    if (previewKey) {
      setPreviewFile(previewKey);
    } else {
      setPreviewFile(null);
      setPreviewContent("");
      setPreviewMetadata(null);
      setPreviewError(null);
    }
  }, []);

  // Load content when preview file changes
  useEffect(() => {
    if (!previewFile) {
      return;
    }
    const controller = new AbortController();
    loadPreviewContent(previewFile, controller.signal);
    return () => {
      controller.abort();
    };
  }, [previewFile, loadPreviewContent]);

  return {
    previewFile,
    previewContent,
    previewLoading,
    previewMetadata,
    previewError,
    handlePreview,
    closePreview,
    setPreviewFile,
    restorePreviewFromURL,
  };
}
