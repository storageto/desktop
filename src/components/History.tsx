import { useState, useRef, useEffect } from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useFloating, offset, flip, shift, autoUpdate, FloatingPortal } from "@floating-ui/react";
import { Tooltip } from "./Tooltip";

export interface CollectionFile {
  id: string;
  filename: string;
  url: string;
  size: number;
}

export interface HistoryItem {
  id: string;
  filename: string;
  url: string;
  size: number;
  uploaded_at: string;
  is_collection: boolean;
  file_count?: number;
  files?: CollectionFile[];
  password_protected?: boolean;
  burn_after_reading?: boolean;
  expires_at?: string;
}

export interface UploadItem {
  id: string;
  filename: string;
  bytesUploaded: number;
  totalBytes: number;
  percentage: number;
  status: "queued" | "initializing" | "uploading" | "confirming" | "complete" | "error";
  error?: string;
  url?: string;
  collectionId?: string;
  collectionName?: string;
}

interface HistoryProps {
  items: HistoryItem[];
  uploads: UploadItem[];
  onDelete: (fileId: string, url: string, isCollection: boolean) => Promise<void>;
  onClearUploads?: () => void;
  onSetPassword: (fileId: string, isCollection: boolean, password: string) => void;
  onRemovePassword: (fileId: string, isCollection: boolean) => void;
  onSetExpiry: (fileId: string, isCollection: boolean, days: number) => void;
  onSetBurnAfterReading: (fileId: string, isCollection: boolean) => void;
  onRemoveBurnAfterReading: (fileId: string, isCollection: boolean) => void;
}

interface ModalState {
  type: "password" | "expiry";
  fileId: string;
  isCollection: boolean;
  filename: string;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

function formatDate(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;

  return date.toLocaleDateString();
}

interface ExpiryInfo {
  text: string;
  color: "gray" | "amber" | "red";
  tooltip: string;
  percentRemaining: number;
  isExpired: boolean;
}

function getExpiryInfo(expiresAt: string): ExpiryInfo {
  const date = new Date(expiresAt);
  const now = new Date();
  const diffMs = date.getTime() - now.getTime();

  // Format tooltip with full date
  const tooltip = date.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

  if (diffMs <= 0) {
    return { text: "Expired", color: "red", tooltip: `Expired ${tooltip}`, percentRemaining: 0, isExpired: true };
  }

  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);
  const remainingHours = diffHours % 24;

  // Calculate percent remaining (assuming 3 day = 72 hour max)
  const maxMs = 72 * 3600000;
  const percentRemaining = Math.min(100, Math.round((diffMs / maxMs) * 100));

  // Determine color based on urgency
  let color: "gray" | "amber" | "red";
  if (diffHours < 24) {
    color = "red";
  } else if (diffDays < 2) {
    color = "amber";
  } else {
    color = "gray";
  }

  // Format text with appropriate precision
  let text: string;
  if (diffMins < 60) {
    text = `${diffMins}m`;
  } else if (diffHours < 24) {
    text = `${diffHours}h`;
  } else if (remainingHours > 0) {
    text = `${diffDays}d ${remainingHours}h`;
  } else {
    text = `${diffDays}d`;
  }

  return { text, color, tooltip: `Expires ${tooltip}`, percentRemaining, isExpired: false };
}

function ExpiryBadge({ expiresAt }: { expiresAt: string }) {
  const info = getExpiryInfo(expiresAt);

  const colorClasses = {
    gray: "text-[#57534e]",
    amber: "text-amber-500",
    red: "text-red-400",
  };

  const bgClasses = {
    gray: "bg-[#57534e]/20",
    amber: "bg-amber-500/20",
    red: "bg-red-400/20",
  };

  return (
    <Tooltip text={info.tooltip}>
      <span
        className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded ${bgClasses[info.color]} ${colorClasses[info.color]} cursor-default`}
      >
        {/* Clock icon */}
        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <span className="text-[10px] font-medium">{info.text}</span>
      </span>
    </Tooltip>
  );
}

function getFileIcon(filename: string, isCollection: boolean, size: "sm" | "md" = "md") {
  const sizeClass = size === "sm" ? "w-3 h-3" : "w-4 h-4";

  if (isCollection) {
    return (
      <svg className={`${sizeClass} text-amber-500`} fill="currentColor" viewBox="0 0 20 20">
        <path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
      </svg>
    );
  }

  const ext = filename.split(".").pop()?.toLowerCase();

  // Image files
  if (["jpg", "jpeg", "png", "gif", "webp", "svg", "bmp"].includes(ext || "")) {
    return (
      <svg className={`${sizeClass} text-pink-500`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
      </svg>
    );
  }

  // Video files
  if (["mp4", "mov", "avi", "mkv", "webm"].includes(ext || "")) {
    return (
      <svg className={`${sizeClass} text-purple-500`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
      </svg>
    );
  }

  // Archive files
  if (["zip", "rar", "7z", "tar", "gz"].includes(ext || "")) {
    return (
      <svg className={`${sizeClass} text-orange-500`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4" />
      </svg>
    );
  }

  // Document files
  if (["pdf", "doc", "docx", "txt", "rtf"].includes(ext || "")) {
    return (
      <svg className={`${sizeClass} text-blue-500`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
      </svg>
    );
  }

  // Default file icon
  return (
    <svg className={`${sizeClass} text-[#71717a]`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
    </svg>
  );
}

function getStatusText(status: UploadItem["status"]): string {
  switch (status) {
    case "queued":
      return "Waiting...";
    case "initializing":
      return "Starting...";
    case "uploading":
      return "Uploading...";
    case "confirming":
      return "Finishing...";
    case "complete":
      return "Complete";
    case "error":
      return "Failed";
  }
}

// Group uploads by collection
interface CollectionUploadGroup {
  collectionId: string;
  collectionName: string;
  files: UploadItem[];
  totalBytes: number;
  bytesUploaded: number;
  percentage: number;
  completedCount: number;
  errorCount: number;
  hasErrors: boolean;
}

function groupUploadsByCollection(uploads: UploadItem[]): {
  collectionGroups: CollectionUploadGroup[];
  standaloneUploads: UploadItem[];
} {
  const collectionMap = new Map<string, UploadItem[]>();
  const standaloneUploads: UploadItem[] = [];

  for (const upload of uploads) {
    if (upload.collectionId && upload.collectionName) {
      const existing = collectionMap.get(upload.collectionId) || [];
      existing.push(upload);
      collectionMap.set(upload.collectionId, existing);
    } else {
      standaloneUploads.push(upload);
    }
  }

  const collectionGroups: CollectionUploadGroup[] = [];
  for (const [collectionId, files] of collectionMap.entries()) {
    const totalBytes = files.reduce((sum, f) => sum + f.totalBytes, 0);
    const bytesUploaded = files.reduce((sum, f) => sum + f.bytesUploaded, 0);
    const completedCount = files.filter(f => f.status === "complete" || f.status === "confirming").length;
    const errorCount = files.filter(f => f.status === "error").length;

    collectionGroups.push({
      collectionId,
      collectionName: files[0].collectionName || "Collection",
      files,
      totalBytes,
      bytesUploaded,
      percentage: totalBytes > 0 ? (bytesUploaded / totalBytes) * 100 : 0,
      completedCount,
      errorCount,
      hasErrors: errorCount > 0,
    });
  }

  return { collectionGroups, standaloneUploads };
}

// Collapsed collection upload component
function CollectionUploadItem({ group }: { group: CollectionUploadGroup }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const isComplete = group.completedCount === group.files.length;
  const isUploading = group.files.some(f => f.status === "uploading" || f.status === "initializing" || f.status === "confirming");

  return (
    <div className="flex flex-col gap-1.5 py-2 px-2 rounded-lg bg-[#1c1917]/50">
      {/* Collapsed header */}
      <div
        className="flex items-center gap-3 cursor-pointer"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        {/* Folder icon with expand/collapse */}
        <div className="w-8 h-8 rounded-lg bg-[#292524] flex items-center justify-center flex-shrink-0">
          {group.hasErrors ? (
            <svg className="w-4 h-4 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          ) : isComplete ? (
            <svg className="w-4 h-4 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          ) : isUploading ? (
            <svg className="w-4 h-4 animate-spin text-amber-500" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
          ) : (
            <svg className="w-4 h-4 text-amber-500" fill="currentColor" viewBox="0 0 20 20">
              <path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
            </svg>
          )}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <p className={`text-sm font-medium truncate ${group.hasErrors ? "text-red-400" : "text-white"}`}>
              {group.collectionName}
            </p>
            <svg
              className={`w-3 h-3 text-[#57534e] transition-transform ${isExpanded ? "rotate-90" : ""}`}
              fill="currentColor"
              viewBox="0 0 20 20"
            >
              <path fillRule="evenodd" d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z" clipRule="evenodd" />
            </svg>
          </div>
          <p className="text-xs text-[#57534e]">
            {group.hasErrors
              ? `${group.errorCount} failed · ${formatBytes(group.totalBytes)}`
              : isComplete
              ? `${group.files.length} files · ${formatBytes(group.totalBytes)}`
              : `${formatBytes(group.bytesUploaded)} / ${formatBytes(group.totalBytes)}`}
          </p>
        </div>

        {/* Progress percentage */}
        {!isComplete && !group.hasErrors && (
          <span className="text-xs text-amber-500 tabular-nums flex-shrink-0 font-medium">
            {Math.round(group.percentage)}%
          </span>
        )}
      </div>

      {/* Progress bar */}
      {!isComplete && !group.hasErrors && (
        <div className="h-1.5 bg-[#292524] rounded-full overflow-hidden ml-11">
          <div
            className="h-full progress-shimmer rounded-full transition-all duration-300 ease-out"
            style={{ width: `${group.percentage}%` }}
          />
        </div>
      )}

      {/* Expanded file list */}
      {isExpanded && (
        <div className="ml-5 border-l-2 border-[#292524] pl-3 mt-1 space-y-0.5 max-h-48 overflow-y-auto">
          {group.files.map((file) => (
            <div
              key={file.id}
              className="flex items-center gap-2 py-1 px-2 rounded"
            >
              {/* Status indicator */}
              <div className="w-5 h-5 flex items-center justify-center flex-shrink-0">
                {file.status === "complete" || file.status === "confirming" ? (
                  <svg className="w-3 h-3 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                ) : file.status === "error" ? (
                  <svg className="w-3 h-3 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                ) : file.status === "uploading" ? (
                  <svg className="w-3 h-3 animate-spin text-amber-500" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                ) : (
                  <svg className="w-3 h-3 text-[#57534e]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                )}
              </div>

              <span className={`text-xs truncate flex-1 ${file.status === "error" ? "text-red-400" : file.status === "queued" ? "text-[#57534e]" : "text-[#a8a29e]"}`}>
                {file.filename}
              </span>

              {file.status === "uploading" && (
                <span className="text-[10px] text-amber-500 tabular-nums flex-shrink-0">
                  {Math.round(file.percentage)}%
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Context Menu Component
function ContextMenu({
  isOpen,
  onClose,
  onCopy,
  onOpen,
  onDelete,
  onPassword,
  onExpiry,
  onBurn,
  anchorRef,
  isChildFile = false,
  hasPassword = false,
  hasBurn = false
}: {
  isOpen: boolean;
  onClose: () => void;
  onCopy: () => void;
  onOpen: () => void;
  onDelete?: () => void;
  onPassword?: () => void;
  onExpiry?: () => void;
  onBurn?: () => void;
  anchorRef: React.RefObject<HTMLButtonElement | null>;
  isChildFile?: boolean;
  hasPassword?: boolean;
  hasBurn?: boolean;
}) {
  const { refs, floatingStyles } = useFloating({
    open: isOpen,
    placement: "bottom-end",
    middleware: [
      offset(4),
      flip({ fallbackPlacements: ["top-end", "bottom-start", "top-start"] }),
      shift({ padding: 8 })
    ],
    whileElementsMounted: autoUpdate,
  });

  // Sync anchor ref to floating reference
  useEffect(() => {
    if (anchorRef.current) {
      refs.setReference(anchorRef.current);
    }
  }, [anchorRef, refs, isOpen]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      const floating = refs.floating.current;
      if (floating && !floating.contains(e.target as Node) &&
          anchorRef.current && !anchorRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen, onClose, anchorRef, refs]);

  if (!isOpen) return null;

  return (
    <FloatingPortal>
      <div
        ref={refs.setFloating}
        style={floatingStyles}
        className="z-50 bg-[#1c1917] border border-[#292524] rounded-lg shadow-xl py-1 min-w-[160px]"
      >
      <button
        onClick={() => { onCopy(); onClose(); }}
        className="w-full px-3 py-2 text-left text-xs text-[#a8a29e] hover:bg-[#292524] hover:text-white flex items-center gap-2 transition-colors cursor-pointer"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3" />
        </svg>
        Copy link
      </button>
      <button
        onClick={() => { onOpen(); onClose(); }}
        className="w-full px-3 py-2 text-left text-xs text-[#a8a29e] hover:bg-[#292524] hover:text-white flex items-center gap-2 transition-colors cursor-pointer"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
        </svg>
        Open in browser
      </button>

      {/* Separator */}
      <div className="border-t border-[#292524] my-1" />

      {/* Protection features */}
      <button
        onClick={() => { onPassword?.(); onClose(); }}
        className={`w-full px-3 py-2 text-left text-xs hover:bg-[#292524] hover:text-white flex items-center gap-2 transition-colors cursor-pointer ${hasPassword ? 'text-amber-400' : 'text-[#a8a29e]'}`}
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
        </svg>
        {hasPassword ? "Remove password" : "Add password"}
      </button>
      <button
        onClick={() => { onExpiry?.(); onClose(); }}
        className="w-full px-3 py-2 text-left text-xs text-[#a8a29e] hover:bg-[#292524] hover:text-white flex items-center gap-2 transition-colors cursor-pointer"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        Set expiry
      </button>
      <button
        onClick={() => { onBurn?.(); onClose(); }}
        className={`w-full px-3 py-2 text-left text-xs hover:bg-[#292524] hover:text-white flex items-center gap-2 transition-colors cursor-pointer ${hasBurn ? 'text-orange-400' : 'text-[#a8a29e]'}`}
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 18.657A8 8 0 016.343 7.343S7 9 9 10c0-2 .5-5 2.986-7C14 5 16.09 5.777 17.656 7.343A7.975 7.975 0 0120 13a7.975 7.975 0 01-2.343 5.657z" />
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.879 16.121A3 3 0 1012.015 11L11 14H9c0 .768.293 1.536.879 2.121z" />
        </svg>
        {hasBurn ? "Disable burn after reading" : "Burn after reading"}
      </button>

      {/* Delete - only for top-level items, not child files */}
      {onDelete && !isChildFile && (
        <>
          <div className="border-t border-[#292524] my-1" />
          <button
            onClick={() => { onDelete(); onClose(); }}
            className="w-full px-3 py-2 text-left text-xs text-red-400 hover:bg-red-500/10 flex items-center gap-2 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
            Delete
          </button>
        </>
      )}
      </div>
    </FloatingPortal>
  );
}

export function History({ items, uploads, onDelete, onClearUploads, onSetPassword, onRemovePassword, onSetExpiry, onSetBurnAfterReading, onRemoveBurnAfterReading }: HistoryProps) {
  const [deleteConfirm, setDeleteConfirm] = useState<{ fileId: string; url: string; filename: string; isCollection: boolean } | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [expandedCollections, setExpandedCollections] = useState<Set<string>>(new Set());
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const menuButtonRefs = useRef<Map<string, HTMLButtonElement | null>>(new Map());
  const [modal, setModal] = useState<ModalState | null>(null);
  const [password, setPassword] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const toggleExpanded = (id: string) => {
    setExpandedCollections(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const handleCopy = async (url: string) => {
    try {
      await writeText(url);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  };

  const handleOpen = async (url: string) => {
    try {
      await openUrl(url);
    } catch (err) {
      console.error("Failed to open:", err);
    }
  };

  const handleDeleteClick = (item: HistoryItem | { url: string; filename: string; is_collection: boolean }) => {
    const urlParts = item.url.split("/");
    const fileId = urlParts.pop() || "";
    setDeleteConfirm({
      fileId,
      url: item.url,
      filename: item.filename,
      isCollection: 'is_collection' in item ? item.is_collection : false
    });
  };

  const handleDeleteConfirm = async () => {
    if (!deleteConfirm) return;
    setIsDeleting(true);
    try {
      await onDelete(deleteConfirm.fileId, deleteConfirm.url, deleteConfirm.isCollection);
    } catch (err) {
      console.error("Failed to delete:", err);
    } finally {
      setIsDeleting(false);
      setDeleteConfirm(null);
    }
  };

  const getFileIdFromUrl = (url: string): string => {
    const urlParts = url.split("/");
    return urlParts.pop() || "";
  };

  const openPasswordModal = (item: HistoryItem | CollectionFile, isCollection: boolean) => {
    const fileId = getFileIdFromUrl(item.url);
    setModal({
      type: "password",
      fileId,
      isCollection,
      filename: item.filename
    });
    setPassword("");
  };

  const openExpiryModal = (item: HistoryItem | CollectionFile, isCollection: boolean) => {
    const fileId = getFileIdFromUrl(item.url);
    setModal({
      type: "expiry",
      fileId,
      isCollection,
      filename: item.filename
    });
  };

  const handlePasswordToggle = (item: HistoryItem, isCollection: boolean) => {
    const fileId = getFileIdFromUrl(item.url);
    if (item.password_protected) {
      onRemovePassword(fileId, isCollection);
    } else {
      openPasswordModal(item, isCollection);
    }
  };

  const handleBurnToggle = (item: HistoryItem, isCollection: boolean) => {
    const fileId = getFileIdFromUrl(item.url);
    if (item.burn_after_reading) {
      onRemoveBurnAfterReading(fileId, isCollection);
    } else {
      onSetBurnAfterReading(fileId, isCollection);
    }
  };

  const handlePasswordSubmit = () => {
    if (!modal || modal.type !== "password" || !password || password.length < 4) return;
    onSetPassword(modal.fileId, modal.isCollection, password);
    setModal(null);
    setPassword("");
  };

  const handleExpirySubmit = (days: number) => {
    if (!modal || modal.type !== "expiry") return;
    onSetExpiry(modal.fileId, modal.isCollection, days);
    setModal(null);
  };

  const activeUploads = uploads.filter(u => u.status !== "complete");
  const errorCount = uploads.filter(u => u.status === "error").length;
  const hasErrors = errorCount > 0;
  const hasContent = items.length > 0 || activeUploads.length > 0;

  // Group ALL uploads by collection (including completed ones for accurate counts)
  const { collectionGroups, standaloneUploads } = groupUploadsByCollection(uploads);

  // Show all uploads including complete (they stay visible until cleared after history loads)
  const activeCollectionGroups = collectionGroups;
  const activeStandaloneUploads = standaloneUploads;

  // Filter items by search query
  const filteredItems = searchQuery.trim()
    ? items.filter(item => {
        const query = searchQuery.toLowerCase();
        // Match item filename
        if (item.filename.toLowerCase().includes(query)) return true;
        // Match collection file names
        if (item.files?.some(f => f.filename.toLowerCase().includes(query))) return true;
        return false;
      })
    : items;

  const openSearch = () => {
    setIsSearchOpen(true);
    setTimeout(() => searchInputRef.current?.focus(), 50);
  };

  const closeSearch = () => {
    setIsSearchOpen(false);
    setSearchQuery("");
  };

  if (!hasContent) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center px-4 py-8">
        <div className="w-12 h-12 rounded-full bg-[#1c1917] flex items-center justify-center mb-3">
          <svg className="w-6 h-6 text-[#57534e]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        </div>
        <p className="text-sm text-[#57534e]">No recent uploads</p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-hidden flex flex-col min-h-0">
      <div className="flex items-center justify-between px-4 py-2 border-t border-[#292524] gap-2">
        {isSearchOpen ? (
          // Search input mode
          <div className="flex-1 flex items-center gap-2">
            <div className="flex-1 relative">
              <svg className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[#57534e]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <input
                ref={searchInputRef}
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Escape" && closeSearch()}
                placeholder="Search files..."
                className="w-full pl-7 pr-2 py-1 text-xs text-white bg-[#1c1917] border border-[#292524] rounded focus:outline-none focus:border-[#57534e] placeholder:text-[#57534e]"
              />
            </div>
            <button
              onClick={closeSearch}
              className="text-[#57534e] hover:text-white transition-colors cursor-pointer"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        ) : (
          // Normal header mode
          <>
            <h3 className="text-[11px] font-semibold text-[#57534e] uppercase tracking-widest">
              {hasErrors
                ? `Upload failed`
                : activeUploads.length > 0
                ? "Uploading"
                : "Recent Uploads"}
            </h3>
            <div className="flex items-center gap-2">
              {items.length > 0 && activeUploads.length === 0 && (
                <Tooltip text="Search uploads">
                  <button
                    onClick={openSearch}
                    className="text-[#57534e] hover:text-[#a8a29e] transition-colors cursor-pointer"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                    </svg>
                  </button>
                </Tooltip>
              )}
              {hasErrors && onClearUploads && (
                <Tooltip text="Dismiss failed uploads">
                  <button
                    onClick={onClearUploads}
                    className="text-[11px] text-red-400 hover:text-red-300 uppercase tracking-wider transition-colors cursor-pointer"
                  >
                    Dismiss
                  </button>
                </Tooltip>
              )}
            </div>
          </>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-3 pb-3">
        <div className="space-y-1">
          {/* Collection uploads (grouped) */}
          {activeCollectionGroups.map((group) => (
            <CollectionUploadItem key={group.collectionId} group={group} />
          ))}

          {/* Standalone uploads (not part of a collection) */}
          {activeStandaloneUploads.map((upload) => (
            <div
              key={upload.id}
              className="flex flex-col gap-1.5 py-2 px-2 rounded-lg bg-[#1c1917]/50"
            >
              <div className="flex items-center gap-3">
                {/* Status icon */}
                <div className="w-8 h-8 rounded-lg bg-[#292524] flex items-center justify-center flex-shrink-0">
                  {upload.status === "error" ? (
                    <svg className="w-4 h-4 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  ) : upload.status === "complete" ? (
                    <svg className="w-4 h-4 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                  ) : upload.status === "queued" ? (
                    <svg className="w-4 h-4 text-[#57534e]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                  ) : (
                    <svg className="w-4 h-4 animate-spin text-amber-500" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                  )}
                </div>

                <div className="flex-1 min-w-0">
                  <p className={`text-sm font-medium truncate ${upload.status === "queued" ? "text-[#a8a29e]" : upload.status === "error" ? "text-red-400" : "text-white"}`}>
                    {upload.filename}
                  </p>
                  <p className={`text-xs truncate ${upload.status === "error" ? "text-red-400/70" : "text-[#57534e]"}`}>
                    {upload.status === "error" && upload.error
                      ? upload.error.length > 50 ? upload.error.substring(0, 50) + "..." : upload.error
                      : getStatusText(upload.status)}
                    {upload.status !== "queued" && upload.status !== "error" && ` · ${formatBytes(upload.totalBytes)}`}
                  </p>
                </div>

                {upload.status === "uploading" && (
                  <span className="text-xs text-amber-500 tabular-nums flex-shrink-0 font-medium">
                    {Math.round(upload.percentage)}%
                  </span>
                )}
              </div>

              {/* Progress bar */}
              {upload.status === "uploading" && (
                <div className="h-1.5 bg-[#292524] rounded-full overflow-hidden ml-11">
                  <div
                    className="h-full progress-shimmer rounded-full transition-all duration-300 ease-out"
                    style={{ width: `${upload.percentage}%` }}
                  />
                </div>
              )}
            </div>
          ))}

          {/* Completed history items */}
          {searchQuery && filteredItems.length === 0 && (
            <div className="py-6 text-center">
              <p className="text-sm text-[#57534e]">No files matching "{searchQuery}"</p>
            </div>
          )}
          {filteredItems.map((item) => {
            const isExpanded = expandedCollections.has(item.id);
            const hasFiles = item.is_collection && item.files && item.files.length > 0;
            const menuKey = `item-${item.id}`;

            return (
              <div key={item.id}>
                <div
                  className="group flex items-center gap-3 py-2 px-2 rounded-lg hover:bg-[#1c1917] transition-colors cursor-pointer relative"
                  onClick={() => handleCopy(item.url)}
                >
                  {/* Expand/collapse button for collections */}
                  {hasFiles ? (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleExpanded(item.id);
                      }}
                      className="w-8 h-8 rounded-lg bg-[#1c1917] group-hover:bg-[#292524] flex items-center justify-center flex-shrink-0 transition-colors cursor-pointer"
                    >
                      <svg
                        className={`w-4 h-4 text-amber-500 transition-transform ${isExpanded ? "rotate-90" : ""}`}
                        fill="currentColor"
                        viewBox="0 0 20 20"
                      >
                        <path fillRule="evenodd" d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z" clipRule="evenodd" />
                      </svg>
                    </button>
                  ) : (
                    <div className="w-8 h-8 rounded-lg bg-[#1c1917] group-hover:bg-[#292524] flex items-center justify-center flex-shrink-0 transition-colors">
                      {getFileIcon(item.filename, item.is_collection)}
                    </div>
                  )}

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <p className="text-sm font-medium text-white truncate">
                        {item.filename}
                        {item.is_collection && item.file_count != null && item.file_count > 0 && (
                          <span className="text-xs text-[#57534e] ml-1.5">
                            ({item.file_count} files)
                          </span>
                        )}
                      </p>
                      {/* Status indicators */}
                      {item.password_protected && (
                        <Tooltip text="Password protected">
                          <span className="flex-shrink-0">
                            <svg className="w-3.5 h-3.5 text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                            </svg>
                          </span>
                        </Tooltip>
                      )}
                      {item.burn_after_reading && (
                        <Tooltip text="Burn after reading">
                          <span className="flex-shrink-0">
                            <svg className="w-3.5 h-3.5 text-orange-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 18.657A8 8 0 016.343 7.343S7 9 9 10c0-2 .5-5 2.986-7C14 5 16.09 5.777 17.656 7.343A7.975 7.975 0 0120 13a7.975 7.975 0 01-2.343 5.657z" />
                            </svg>
                          </span>
                        </Tooltip>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5 text-xs text-[#57534e]">
                      <span>{formatBytes(item.size)}</span>
                      <span>·</span>
                      <span>{formatDate(item.uploaded_at)}</span>
                      {item.expires_at && (
                        <ExpiryBadge expiresAt={item.expires_at} />
                      )}
                    </div>
                  </div>

                  {/* Menu button */}
                  <Tooltip text="More options">
                    <button
                      ref={(el) => { menuButtonRefs.current.set(menuKey, el); }}
                      onClick={(e) => {
                        e.stopPropagation();
                        setOpenMenu(openMenu === menuKey ? null : menuKey);
                      }}
                      className="w-8 h-8 flex items-center justify-center rounded-lg opacity-0 group-hover:opacity-100 bg-[#292524] hover:bg-[#3f3f46] text-[#a8a29e] hover:text-white transition-all cursor-pointer"
                    >
                      <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                        <path d="M10 6a2 2 0 110-4 2 2 0 010 4zM10 12a2 2 0 110-4 2 2 0 010 4zM10 18a2 2 0 110-4 2 2 0 010 4z" />
                      </svg>
                    </button>
                  </Tooltip>

                  {/* Context Menu */}
                  <ContextMenu
                    isOpen={openMenu === menuKey}
                    onClose={() => setOpenMenu(null)}
                    onCopy={() => handleCopy(item.url)}
                    onOpen={() => handleOpen(item.url)}
                    onDelete={() => handleDeleteClick(item)}
                    onPassword={() => handlePasswordToggle(item, item.is_collection)}
                    onExpiry={() => openExpiryModal(item, item.is_collection)}
                    onBurn={() => handleBurnToggle(item, item.is_collection)}
                    anchorRef={{ current: menuButtonRefs.current.get(menuKey) || null }}
                    hasPassword={item.password_protected}
                    hasBurn={item.burn_after_reading}
                  />
                </div>

                {/* Expanded files list */}
                {isExpanded && hasFiles && (
                  <div className="ml-5 border-l-2 border-[#292524] pl-3 mt-1 mb-2 space-y-0.5">
                    {item.files!.map((file) => {
                      const fileMenuKey = `file-${file.id}`;

                      return (
                        <div
                          key={file.id}
                          className="group flex items-center gap-2 py-1.5 px-2 rounded-lg hover:bg-[#1c1917] transition-colors cursor-pointer relative"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleCopy(file.url);
                          }}
                        >
                          <div className="w-6 h-6 rounded bg-[#1c1917] group-hover:bg-[#292524] flex items-center justify-center flex-shrink-0 transition-colors">
                            {getFileIcon(file.filename, false, "sm")}
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-xs text-[#a8a29e] truncate">{file.filename}</p>
                          </div>
                          <span className="text-[11px] text-[#57534e] flex-shrink-0">{formatBytes(file.size)}</span>

                          {/* Menu button for child file */}
                          <Tooltip text="More options">
                            <button
                              ref={(el) => { menuButtonRefs.current.set(fileMenuKey, el); }}
                              onClick={(e) => {
                                e.stopPropagation();
                                setOpenMenu(openMenu === fileMenuKey ? null : fileMenuKey);
                              }}
                              className="w-6 h-6 flex items-center justify-center rounded opacity-0 group-hover:opacity-100 bg-[#292524] hover:bg-[#3f3f46] text-[#a8a29e] hover:text-white transition-all cursor-pointer"
                            >
                              <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                                <path d="M10 6a2 2 0 110-4 2 2 0 010 4zM10 12a2 2 0 110-4 2 2 0 010 4zM10 18a2 2 0 110-4 2 2 0 010 4z" />
                              </svg>
                            </button>
                          </Tooltip>

                          {/* Context Menu for child file */}
                          <ContextMenu
                            isOpen={openMenu === fileMenuKey}
                            onClose={() => setOpenMenu(null)}
                            onCopy={() => handleCopy(file.url)}
                            onOpen={() => handleOpen(file.url)}
                            onPassword={() => openPasswordModal(file, false)}
                            onExpiry={() => openExpiryModal(file, false)}
                            onBurn={() => onSetBurnAfterReading(getFileIdFromUrl(file.url), false)}
                            anchorRef={{ current: menuButtonRefs.current.get(fileMenuKey) || null }}
                            isChildFile={true}
                          />
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Delete confirmation modal */}
      {deleteConfirm && (
        <div className="absolute inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
          <div className="bg-[#1c1917] border border-[#292524] rounded-xl p-5 max-w-[300px] w-full shadow-xl">
            <h4 className="text-base font-semibold text-white mb-2">Delete from storage.to?</h4>
            <p className="text-sm text-[#a8a29e] mb-1 truncate">{deleteConfirm.filename}</p>
            <p className="text-xs text-[#57534e] mb-5">This will permanently delete the file from storage.to servers.</p>
            <div className="flex gap-2">
              <button
                onClick={() => setDeleteConfirm(null)}
                disabled={isDeleting}
                className="flex-1 px-4 py-2 text-sm font-medium text-[#a8a29e] bg-[#292524] hover:bg-[#3f3f46] rounded-lg transition-colors cursor-pointer disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleDeleteConfirm}
                disabled={isDeleting}
                className="flex-1 px-4 py-2 text-sm font-medium text-white bg-red-600 hover:bg-red-700 rounded-lg transition-colors cursor-pointer disabled:opacity-50"
              >
                {isDeleting ? "Deleting..." : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Password modal */}
      {modal?.type === "password" && (
        <div className="absolute inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
          <div className="bg-[#1c1917] border border-[#292524] rounded-xl p-5 max-w-[300px] w-full shadow-xl">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-lg bg-[#292524] flex items-center justify-center">
                <svg className="w-5 h-5 text-[#f472b6]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                </svg>
              </div>
              <div>
                <h4 className="text-base font-semibold text-white">Add password</h4>
                <p className="text-xs text-[#57534e] truncate max-w-[180px]">{modal.filename}</p>
              </div>
            </div>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter password (min 4 chars)"
              className="w-full px-3 py-2.5 text-sm text-white bg-[#0c0a09] border border-[#292524] rounded-lg focus:outline-none focus:border-[#f472b6] focus:ring-1 focus:ring-[#f472b6] mb-4 placeholder:text-[#57534e]"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter" && password.length >= 4) {
                  handlePasswordSubmit();
                }
              }}
            />
            <div className="flex gap-2">
              <button
                onClick={() => { setModal(null); setPassword(""); }}
                className="flex-1 px-4 py-2 text-sm font-medium text-[#a8a29e] bg-[#292524] hover:bg-[#3f3f46] rounded-lg transition-colors cursor-pointer"
              >
                Cancel
              </button>
              <button
                onClick={handlePasswordSubmit}
                disabled={password.length < 4}
                className="flex-1 px-4 py-2 text-sm font-medium text-white bg-[#f472b6] hover:bg-[#ec4899] rounded-lg transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Set password
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Expiry modal */}
      {modal?.type === "expiry" && (
        <div className="absolute inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
          <div className="bg-[#1c1917] border border-[#292524] rounded-xl p-5 max-w-[300px] w-full shadow-xl">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-lg bg-[#292524] flex items-center justify-center">
                <svg className="w-5 h-5 text-[#f472b6]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
              <div>
                <h4 className="text-base font-semibold text-white">Set expiry</h4>
                <p className="text-xs text-[#57534e] truncate max-w-[180px]">{modal.filename}</p>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2 mb-4">
              {[1, 2, 3, 5, 7].map((days) => (
                <button
                  key={days}
                  onClick={() => handleExpirySubmit(days)}
                  className="px-3 py-2.5 text-sm font-medium text-white bg-[#292524] hover:bg-[#3f3f46] rounded-lg transition-colors cursor-pointer"
                >
                  {days} {days === 1 ? "day" : "days"}
                </button>
              ))}
            </div>
            <button
              onClick={() => setModal(null)}
              className="w-full px-4 py-2 text-sm font-medium text-[#a8a29e] bg-[#1c1917] border border-[#292524] hover:bg-[#292524] rounded-lg transition-colors cursor-pointer"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
