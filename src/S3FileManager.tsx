import { useState, useEffect, useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import Markdown from "react-markdown";

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

export function S3FileManager() {
  const [objects, setObjects] = useState<S3Object[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [previewFile, setPreviewFile] = useState<string | null>(null);
  const [previewContent, setPreviewContent] = useState<string>("");
  const [previewLoading, setPreviewLoading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

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

  const handleUpload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;

    setUploading(true);
    setError(null);

    try {
      for (const file of Array.from(files)) {
        const formData = new FormData();
        formData.append("file", file);

        const response = await fetch("/api/s3/upload", {
          method: "POST",
          body: formData,
        });

        const data = await response.json();
        if (data.error) {
          setError(data.error);
          break;
        }
      }
      await fetchObjects();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to upload file");
    } finally {
      setUploading(false);
    }
  };

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
      a.download = key;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to download file");
    }
  };

  const handleDelete = async (key: string) => {
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
    } finally {
      setDeleteConfirm(null);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    handleUpload(e.dataTransfer.files);
  };

  const handlePreview = async (key: string) => {
    setPreviewFile(key);
    setPreviewLoading(true);
    setPreviewContent("");
    try {
      const response = await fetch(`/api/s3/preview?key=${encodeKey(key)}`);
      if (!response.ok) {
        const data = await response.json();
        setError(data.error || "Failed to preview file");
        setPreviewFile(null);
        return;
      }
      const content = await response.text();
      setPreviewContent(content);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to preview file");
      setPreviewFile(null);
    } finally {
      setPreviewLoading(false);
    }
  };

  const closePreview = () => {
    setPreviewFile(null);
    setPreviewContent("");
  };

  return (
    <Card className="w-full">
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>S3 File Manager</CardTitle>
            <CardDescription>Manage files in your S3 bucket</CardDescription>
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

        {/* Upload Area */}
        <div
          className={`border-2 border-dashed rounded-lg p-6 text-center transition-colors ${
            isDragging
              ? "border-primary bg-primary/5"
              : "border-muted-foreground/25 hover:border-muted-foreground/50"
          }`}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => handleUpload(e.target.files)}
          />
          <p className="text-muted-foreground mb-2">
            Drag and drop files here, or
          </p>
          <Button
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            size="sm"
          >
            {uploading ? "Uploading..." : "Select Files"}
          </Button>
        </div>

        {/* File List */}
        <div className="border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="text-left p-3 font-medium">Name</th>
                <th className="text-left p-3 font-medium">Size</th>
                <th className="text-left p-3 font-medium">Last Modified</th>
                <th className="text-right p-3 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {objects.length === 0 ? (
                <tr>
                  <td colSpan={4} className="p-6 text-center text-muted-foreground">
                    {loading ? "Loading..." : "No files in bucket"}
                  </td>
                </tr>
              ) : (
                objects.map((obj) => (
                  <tr key={obj.key} className="border-t hover:bg-muted/30">
                    <td className="p-3 font-mono text-xs break-all">{obj.key}</td>
                    <td className="p-3 whitespace-nowrap">{formatBytes(obj.size)}</td>
                    <td className="p-3 whitespace-nowrap">{formatDate(obj.lastModified)}</td>
                    <td className="p-3 text-right space-x-2">
                      {deleteConfirm === obj.key ? (
                        <>
                          <Button
                            size="sm"
                            variant="destructive"
                            onClick={() => handleDelete(obj.key)}
                          >
                            Confirm
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setDeleteConfirm(null)}
                          >
                            Cancel
                          </Button>
                        </>
                      ) : (
                        <>
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
                            onClick={() => setDeleteConfirm(obj.key)}
                          >
                            Delete
                          </Button>
                        </>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Preview Modal */}
        {previewFile && (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
            <div className="bg-background rounded-lg shadow-lg max-w-4xl w-full max-h-[90vh] flex flex-col">
              <div className="flex items-center justify-between p-4 border-b">
                <h2 className="text-lg font-semibold truncate pr-4">{previewFile}</h2>
                <Button variant="ghost" size="sm" onClick={closePreview}>
                  Close
                </Button>
              </div>
              <div className="flex-1 overflow-auto p-4">
                {previewLoading ? (
                  <div className="text-center text-muted-foreground py-8">
                    Loading...
                  </div>
                ) : isMarkdown(previewFile) ? (
                  <div className="prose prose-sm dark:prose-invert max-w-none">
                    <Markdown>{previewContent}</Markdown>
                  </div>
                ) : (
                  <pre className="font-mono text-sm whitespace-pre-wrap break-words">
                    {previewContent}
                  </pre>
                )}
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default S3FileManager;
