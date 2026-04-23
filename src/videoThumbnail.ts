import { invoke } from "@tauri-apps/api/core";
import { reportError } from "./errorReporter";

const VIDEO_EXTENSIONS = [".mp4", ".webm", ".mov"];
const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".tiff", ".tif"];
const THUMBNAIL_TIMEOUT_MS = 8000;
const THUMBNAIL_MAX_WIDTH = 640;
const THUMBNAIL_JPEG_QUALITY = 0.85;
const MAX_FILE_SIZE_FOR_THUMBNAIL = 500 * 1024 * 1024; // 500MB
// Skip thumbnail generation for images that are already tiny — the file
// itself is a fine preview, and the server falls back to its signed URL.
const THUMBNAIL_SKIP_MIN_WIDTH = 400;
const THUMBNAIL_SKIP_MIN_BYTES = 50 * 1024;

/**
 * Check if a file path is a supported video format
 */
function isVideoFile(path: string): boolean {
  const lower = path.toLowerCase();
  return VIDEO_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * Extract file ID from a storage.to URL
 * e.g. "https://storage.to/ABC123" -> "ABC123"
 */
function extractFileId(url: string): string | null {
  try {
    const parts = new URL(url).pathname.split("/").filter(Boolean);
    return parts[parts.length - 1] || null;
  } catch {
    return null;
  }
}

/**
 * Get auth headers for API calls (same pattern as analyticsReporter)
 */
async function getAuthHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    Accept: "application/json",
  };

  try {
    const token = await invoke<string | null>("get_visitor_token_command");
    if (token) headers["X-Visitor-Token"] = token;
  } catch {}

  try {
    const config = await invoke<{ auth_token: string | null }>("get_config");
    if (config.auth_token) headers["Authorization"] = `Bearer ${config.auth_token}`;
  } catch {}

  return headers;
}

/**
 * Get the MIME type for a video file based on extension
 */
function getVideoMimeType(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".webm")) return "video/webm";
  if (lower.endsWith(".mov")) return "video/quicktime";
  return "video/mp4";
}

/**
 * Extract a thumbnail frame from a local video file.
 * Reads the file via Tauri's fs plugin, creates a blob URL,
 * then uses <video> + <canvas> to extract a frame.
 */
async function extractVideoThumbnail(filePath: string): Promise<Blob | null> {
  // Read the file using Rust command (bypasses fs plugin scope restrictions)
  let fileBytes: Uint8Array;
  try {
    const b64 = await invoke<string>("read_file_bytes", { path: filePath });
    const binary = atob(b64);
    fileBytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) fileBytes[i] = binary.charCodeAt(i);
  } catch (e) {
    reportError({ type: "thumbnail", message: `Video read failed: ${e}`, context: { path: filePath, step: "read_file_bytes" } });
    return null;
  }

  // Skip very large files to avoid memory pressure
  if (fileBytes.byteLength > MAX_FILE_SIZE_FOR_THUMBNAIL) {
    reportError({ type: "thumbnail", message: "Video too large, skipped", context: { path: filePath, step: "size_check", byteLength: fileBytes.byteLength } });
    return null;
  }

  const mimeType = getVideoMimeType(filePath);
  const videoBlob = new Blob([fileBytes], { type: mimeType });
  const blobUrl = URL.createObjectURL(videoBlob);

  try {
    const result = await captureFrame(blobUrl);
    if (!result) {
      reportError({ type: "thumbnail", message: "Video captureFrame returned null", context: { path: filePath, step: "captureFrame", mimeType, byteLength: fileBytes.byteLength } });
    }
    return result;
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

/**
 * Load a video from a URL, seek to a representative frame, and capture it.
 * The video element is temporarily added to the DOM (hidden) so WebKit
 * actually decodes frames — off-screen elements often produce black canvases.
 */
function captureFrame(videoUrl: string): Promise<Blob | null> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      reportError({ type: "thumbnail", message: "Video captureFrame timed out", context: { step: "captureFrame_timeout" } });
      cleanup();
      resolve(null);
    }, THUMBNAIL_TIMEOUT_MS);

    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.style.position = "fixed";
    video.style.top = "-9999px";
    video.style.width = "1px";
    video.style.height = "1px";
    video.style.opacity = "0";
    document.body.appendChild(video);

    const cleanup = () => {
      clearTimeout(timeout);
      video.pause();
      video.removeAttribute("src");
      video.load();
      video.remove();
    };

    const capture = () => {
      try {
        const w = video.videoWidth;
        const h = video.videoHeight;
        if (!w || !h) {
          reportError({ type: "thumbnail", message: "No video dimensions", context: { step: "capture_dimensions", w, h } });
          cleanup();
          resolve(null);
          return;
        }

        const canvas = document.createElement("canvas");
        let width = w;
        let height = h;
        if (width > THUMBNAIL_MAX_WIDTH) {
          height = Math.round(height * (THUMBNAIL_MAX_WIDTH / width));
          width = THUMBNAIL_MAX_WIDTH;
        }
        canvas.width = width;
        canvas.height = height;
        canvas.getContext("2d")!.drawImage(video, 0, 0, width, height);

        canvas.toBlob(
          (blob) => {
            cleanup();
            resolve(blob);
          },
          "image/jpeg",
          THUMBNAIL_JPEG_QUALITY
        );
      } catch (e) {
        reportError({ type: "thumbnail", message: `Video canvas error: ${e}`, context: { step: "capture_canvas" } });
        cleanup();
        resolve(null);
      }
    };

    video.addEventListener("error", () => {
      reportError({ type: "thumbnail", message: `Video element error: ${video.error?.message || "unknown"}`, context: { step: "video_element", code: video.error?.code } });
      cleanup();
      resolve(null);
    });

    // Play to force WebKit to start decoding, then seek to target frame
    video.addEventListener("canplay", () => {
      video.play().then(() => {
        video.pause();
        const seekTarget = Math.max(0.5, video.duration * 0.1);
        if (Math.abs(video.currentTime - seekTarget) < 0.1) {
          setTimeout(capture, 100);
          return;
        }
        video.currentTime = seekTarget;
      }).catch(() => {
        // play() rejected — try seeking directly
        const seekTarget = Math.max(0.5, video.duration * 0.1);
        video.currentTime = seekTarget;
      });
    }, { once: true });

    video.addEventListener("seeked", () => {
      setTimeout(capture, 200);
    }, { once: true });

    video.src = videoUrl;
    video.load();
  });
}

/**
 * Check if a file path is a supported image format
 */
function isImageFile(path: string): boolean {
  const lower = path.toLowerCase();
  return IMAGE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * Get the MIME type for an image file based on extension
 */
function getImageMimeType(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".bmp")) return "image/bmp";
  if (lower.endsWith(".tiff") || lower.endsWith(".tif")) return "image/tiff";
  return "image/jpeg";
}

/**
 * Extract a thumbnail from a local image file.
 * Reads the file, loads into <img>, scales down via canvas.
 * Skips tiny images — the file itself is already thumbnail-sized.
 */
async function extractImageThumbnail(filePath: string): Promise<Blob | null> {
  let fileBytes: Uint8Array;
  try {
    const b64 = await invoke<string>("read_file_bytes", { path: filePath });
    const binary = atob(b64);
    fileBytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) fileBytes[i] = binary.charCodeAt(i);
  } catch (e) {
    reportError({ type: "thumbnail", message: `Image read failed: ${e}`, context: { path: filePath, step: "read_file_bytes" } });
    return null;
  }

  if (fileBytes.length < THUMBNAIL_SKIP_MIN_BYTES) {
    return null;
  }

  const mimeType = getImageMimeType(filePath);
  const imageBlob = new Blob([fileBytes], { type: mimeType });
  const blobUrl = URL.createObjectURL(imageBlob);

  try {
    const result = await resizeImage(blobUrl);
    if (!result) {
      reportError({ type: "thumbnail", message: "Image resizeImage returned null", context: { path: filePath, step: "resizeImage", mimeType, byteLength: fileBytes.byteLength } });
    }
    return result;
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

/**
 * Load an image, scale down if wider than max width, and return as JPEG blob.
 */
function resizeImage(imageUrl: string): Promise<Blob | null> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      reportError({ type: "thumbnail", message: "Image resize timed out", context: { step: "resizeImage_timeout" } });
      resolve(null);
    }, THUMBNAIL_TIMEOUT_MS);

    const img = new Image();

    img.addEventListener("error", () => {
      clearTimeout(timeout);
      reportError({ type: "thumbnail", message: "Image element load error", context: { step: "img_element", src: imageUrl.substring(0, 50) } });
      resolve(null);
    });

    img.addEventListener("load", () => {
      try {
        if (img.naturalWidth < THUMBNAIL_SKIP_MIN_WIDTH) {
          clearTimeout(timeout);
          resolve(null);
          return;
        }

        const canvas = document.createElement("canvas");
        let width = img.naturalWidth;
        let height = img.naturalHeight;
        if (width > THUMBNAIL_MAX_WIDTH) {
          const ratio = THUMBNAIL_MAX_WIDTH / width;
          width = THUMBNAIL_MAX_WIDTH;
          height = Math.round(height * ratio);
        }
        canvas.width = width;
        canvas.height = height;
        canvas.getContext("2d")!.drawImage(img, 0, 0, width, height);

        canvas.toBlob(
          (blob) => {
            clearTimeout(timeout);
            resolve(blob);
          },
          "image/jpeg",
          THUMBNAIL_JPEG_QUALITY
        );
      } catch (e) {
        clearTimeout(timeout);
        reportError({ type: "thumbnail", message: `Image canvas error: ${e}`, context: { step: "resizeImage_canvas" } });
        resolve(null);
      }
    });

    img.src = imageUrl;
  });
}

/**
 * Convert a blob to a data URL for local storage/display.
 */
function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

/**
 * Create a tiny icon-sized blob (64px) from a thumbnail blob for local history display.
 */
function createIconBlob(blob: Blob): Promise<Blob | null> {
  return new Promise((resolve) => {
    const img = new Image();
    const blobUrl = URL.createObjectURL(blob);
    img.addEventListener("error", () => { URL.revokeObjectURL(blobUrl); resolve(null); });
    img.addEventListener("load", () => {
      try {
        const canvas = document.createElement("canvas");
        const size = 64;
        const scale = Math.min(size / img.naturalWidth, size / img.naturalHeight);
        canvas.width = Math.round(img.naturalWidth * scale);
        canvas.height = Math.round(img.naturalHeight * scale);
        canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
        canvas.toBlob((b) => { URL.revokeObjectURL(blobUrl); resolve(b); }, "image/jpeg", 0.7);
      } catch { URL.revokeObjectURL(blobUrl); resolve(null); }
    });
    img.src = blobUrl;
  });
}

/**
 * Upload a thumbnail blob to the API.
 */
async function uploadThumbnail(fileId: string, blob: Blob): Promise<void> {
  const headers = await getAuthHeaders();
  const formData = new FormData();
  formData.append("thumbnail", blob, "thumbnail.jpg");

  const response = await fetch(`https://storage.to/api/file/${fileId}/thumbnail`, {
    method: "POST",
    headers,
    body: formData,
  });

  if (!response.ok) {
    throw new Error(`Thumbnail upload failed: ${response.status}`);
  }
}

/**
 * Generate thumbnail icons and save to history (fast, all local).
 * Call this BEFORE loadHistory() so icons are ready when the UI renders.
 * Returns the extracted blobs for subsequent API upload.
 */
export async function generateThumbnailIcons(
  paths: string[],
  urls: string[]
): Promise<Map<string, Blob>> {
  const blobs = new Map<string, Blob>();

  for (let i = 0; i < paths.length; i++) {
    const path = paths[i];
    const url = urls[i];

    if (!path || !url) continue;

    const isVideo = isVideoFile(path);
    const isImage = isImageFile(path);
    if (!isVideo && !isImage) continue;

    try {
      const blob = isVideo
        ? await extractVideoThumbnail(path)
        : await extractImageThumbnail(path);

      if (!blob) {
        console.log("[Thumbnail] No thumbnail extracted for:", path);
        continue;
      }

      const fileId = extractFileId(url);
      if (fileId) blobs.set(fileId, blob);

      const iconBlob = await createIconBlob(blob);
      if (iconBlob) {
        const dataUrl = await blobToDataUrl(iconBlob);
        await invoke("set_history_thumbnail", { url, thumbnailUrl: dataUrl }).catch(() => {});
      }
    } catch (e) {
      reportError({ type: "thumbnail", message: `Thumbnail generation threw: ${e}`, context: { path, step: "generateThumbnailIcons_catch" } });
    }
  }

  return blobs;
}

/**
 * Upload thumbnail blobs to the API (slow, network).
 * Fire-and-forget — errors are logged but never thrown.
 */
export async function uploadThumbnails(blobs: Map<string, Blob>): Promise<void> {
  for (const [fileId, blob] of blobs) {
    try {
      console.log("[Thumbnail] Uploading thumbnail for file:", fileId);
      await uploadThumbnail(fileId, blob);
      console.log("[Thumbnail] Thumbnail uploaded for file:", fileId);
    } catch (e) {
      console.warn("[Thumbnail] Upload failed for", fileId, e);
    }
  }
}

/** @deprecated Use generateThumbnailIcons + uploadThumbnails instead */
export async function processVideoThumbnails(paths: string[], urls: string[]): Promise<void> {
  const blobs = await generateThumbnailIcons(paths, urls);
  await uploadThumbnails(blobs);
}
