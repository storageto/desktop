import { useState, useCallback, useEffect, useRef } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import clsx from "clsx";

interface DropZoneProps {
  onFilesSelected: (paths: string[]) => void;
  disabled?: boolean;
}

interface DragDropPayload {
  paths: string[];
  position: { x: number; y: number };
}

export function DropZone({ onFilesSelected, disabled }: DropZoneProps) {
  const [isDragOver, setIsDragOver] = useState(false);
  const lastDropTime = useRef<number>(0);

  // Listen for Tauri's native file drop events
  useEffect(() => {
    let unlistenDrop: (() => void) | undefined;
    let unlistenHover: (() => void) | undefined;
    let unlistenLeave: (() => void) | undefined;

    const setupListeners = async () => {
      // Listen for file drop
      unlistenDrop = await listen<DragDropPayload>("tauri://drag-drop", (event) => {
        setIsDragOver(false);

        // Debounce: Tauri fires drag-drop multiple times for a single drop
        const now = Date.now();
        if (now - lastDropTime.current < 500) return;
        lastDropTime.current = now;

        if (!disabled && event.payload.paths.length > 0) {
          onFilesSelected(event.payload.paths);
        }
      });

      // Listen for drag hover
      unlistenHover = await listen("tauri://drag-enter", () => {
        if (!disabled) {
          setIsDragOver(true);
        }
      });

      // Listen for drag leave
      unlistenLeave = await listen("tauri://drag-leave", () => {
        setIsDragOver(false);
      });
    };

    setupListeners();

    return () => {
      unlistenDrop?.();
      unlistenHover?.();
      unlistenLeave?.();
    };
  }, [onFilesSelected, disabled]);

  // Also handle browser drag events for visual feedback
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // Tauri handles the actual file drop via its event system
  }, []);

  const handleClick = useCallback(async () => {
    if (disabled) return;

    try {
      const selected = await open({
        multiple: true,
        directory: false,
      });

      if (selected) {
        const paths = Array.isArray(selected) ? selected : [selected];
        if (paths.length > 0) {
          onFilesSelected(paths);
        }
      }
    } catch (err) {
      console.error("Failed to open file dialog:", err);
    }
  }, [onFilesSelected, disabled]);

  return (
    <div className="p-3">
      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={handleClick}
        className={clsx(
          "relative flex flex-col items-center justify-center",
          "h-24 rounded-lg border transition-all duration-200",
          "cursor-pointer",
          isDragOver
            ? "border-amber-500/50 bg-amber-500/5"
            : "border-[#292524] bg-[#1c1917]/50 hover:border-[#3f3f46] hover:bg-[#1c1917]",
          disabled && "opacity-50 cursor-not-allowed"
        )}
      >
        {/* Upload icon */}
        <div
          className={clsx(
            "w-9 h-9 rounded-full flex items-center justify-center mb-2 transition-colors",
            isDragOver ? "bg-amber-500/10" : "bg-[#292524]"
          )}
        >
          <svg
            className={clsx(
              "w-4 h-4 transition-colors",
              isDragOver ? "text-amber-500" : "text-[#a8a29e]"
            )}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"
            />
          </svg>
        </div>

        <p className={clsx(
          "text-xs font-medium transition-colors",
          isDragOver ? "text-amber-500" : "text-[#a8a29e]"
        )}>
          {isDragOver ? "Drop to upload" : "Drop files or click to select"}
        </p>
      </div>
    </div>
  );
}
