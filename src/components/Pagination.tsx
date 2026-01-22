import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight } from "lucide-react";

interface PaginationProps {
  currentPage: number;      // Current page (1-indexed)
  totalPages: number;       // Total pages
  totalItems: number;       // Total items for display
  pageSize: number;         // Items per page
  loading: boolean;
  onPageChange: (page: number) => void;
}

function getPageNumbers(currentPage: number, totalPages: number): (number | "ellipsis")[] {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, i) => i + 1);
  }

  const pages: (number | "ellipsis")[] = [];

  // Always show first page
  pages.push(1);

  if (currentPage <= 3) {
    // Near start: [1] [2] [3] [4] ... [last]
    pages.push(2, 3, 4, "ellipsis", totalPages);
  } else if (currentPage >= totalPages - 2) {
    // Near end: [1] ... [last-3] [last-2] [last-1] [last]
    pages.push("ellipsis", totalPages - 3, totalPages - 2, totalPages - 1, totalPages);
  } else {
    // Middle: [1] ... [curr-1] [curr] [curr+1] ... [last]
    pages.push("ellipsis", currentPage - 1, currentPage, currentPage + 1, "ellipsis", totalPages);
  }

  return pages;
}

export function Pagination({
  currentPage,
  totalPages,
  totalItems,
  pageSize,
  loading,
  onPageChange,
}: PaginationProps) {
  // Hide pagination for zero results
  if (totalItems === 0) return null;

  const startItem = (currentPage - 1) * pageSize + 1;
  const endItem = Math.min(currentPage * pageSize, totalItems);

  const isFirstPage = currentPage === 1;
  const isLastPage = currentPage === totalPages || totalPages === 0;

  // Always show pagination with navigation, even for single page
  const effectiveTotalPages = Math.max(1, totalPages);
  const pageNumbers = getPageNumbers(currentPage, effectiveTotalPages);

  return (
    <div className="flex items-center justify-between py-4 gap-4">
      <div className="text-sm text-muted-foreground whitespace-nowrap">
        Showing {startItem}-{endItem} of {totalItems}
      </div>

      <div className="flex items-center gap-1">
        {/* Previous button */}
        <Button
          variant="outline"
          size="icon"
          className="h-8 w-8"
          onClick={() => onPageChange(currentPage - 1)}
          disabled={isFirstPage || loading}
          title="Previous page"
        >
          <ChevronLeft className="size-4" />
        </Button>

        {/* Page numbers */}
        {pageNumbers.map((page, index) => {
          if (page === "ellipsis") {
            return (
              <span
                key={`ellipsis-${index}`}
                className="px-2 text-muted-foreground"
              >
                ...
              </span>
            );
          }

          return (
            <Button
              key={page}
              variant={page === currentPage ? "default" : "outline"}
              size="sm"
              className="h-8 w-8 p-0"
              onClick={() => onPageChange(page)}
              disabled={loading}
            >
              {page}
            </Button>
          );
        })}

        {/* Next button */}
        <Button
          variant="outline"
          size="icon"
          className="h-8 w-8"
          onClick={() => onPageChange(currentPage + 1)}
          disabled={isLastPage || loading}
          title="Next page"
        >
          <ChevronRight className="size-4" />
        </Button>
      </div>
    </div>
  );
}
