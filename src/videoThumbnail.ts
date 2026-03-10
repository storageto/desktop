import { invoke } from "@tauri-apps/api/core";
import { readFile } from "@tauri-apps/plugin-fs";

const VIDEO_EXTENSIONS = [".mp4", ".webm", ".mov"];
const THUMBNAIL_TIMEOUT_MS = 8000;
const THUMBNAIL_MAX_WIDTH = 1280;
const THUMBNAIL_JPEG_QUALITY = 0.85;
const MAX_FILE_SIZE_FOR_THUMBNAIL = 500 * 1024 * 1024; // 500MB

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
  // Read the file using Tauri's fs plugin
  let fileBytes: Uint8Array;
  try {
    fileBytes = await readFile(filePath);
  } catch (e) {
    console.warn("[Thumbnail] Failed to read file:", e);
    return null;
  }

  // Skip very large files to avoid memory pressure
  if (fileBytes.byteLength > MAX_FILE_SIZE_FOR_THUMBNAIL) {
    console.log("[Thumbnail] Skipping large file:", filePath);
    return null;
  }

  const mimeType = getVideoMimeType(filePath);
  const videoBlob = new Blob([fileBytes], { type: mimeType });
  const blobUrl = URL.createObjectURL(videoBlob);

  try {
    return await captureFrame(blobUrl);
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
      console.warn("[Thumbnail] Timed out");
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
          console.warn("[Thumbnail] No video dimensions");
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
        console.warn("[Thumbnail] Canvas error:", e);
        cleanup();
        resolve(null);
      }
    };

    video.addEventListener("error", () => {
      console.warn("[Thumbnail] Video error:", video.error?.message);
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
 * Upload a thumbnail blob to the API
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
 * Process uploaded files and extract/upload thumbnails for any videos.
 * Fire-and-forget — errors are logged but never thrown.
 *
 * @param paths - Local file paths that were uploaded
 * @param urls - Corresponding storage.to URLs from upload results
 */
export async function processVideoThumbnails(
  paths: string[],
  urls: string[]
): Promise<void> {
  for (let i = 0; i < paths.length; i++) {
    const path = paths[i];
    const url = urls[i];

    if (!path || !url || !isVideoFile(path)) continue;

    const fileId = extractFileId(url);
    if (!fileId) continue;

    try {
      console.log("[Thumbnail] Extracting thumbnail for:", path);
      const blob = await extractVideoThumbnail(path);
      if (!blob) {
        console.log("[Thumbnail] No thumbnail extracted for:", path);
        continue;
      }

      console.log("[Thumbnail] Uploading thumbnail for file:", fileId);
      await uploadThumbnail(fileId, blob);
      console.log("[Thumbnail] Thumbnail uploaded for file:", fileId);
    } catch (e) {
      console.warn("[Thumbnail] Failed for", path, e);
    }
  }
}
