mod storage;
mod upload;

use std::fs;
use std::path::Path;
use std::sync::Mutex;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use storage::{
    clear_history, get_history, load_config, save_config, AppConfig, UploadHistoryItem,
    add_to_history, remove_from_history, CollectionFileItem, check_first_launch,
    get_visitor_token, get_auth_token, get_api_url,
};
use tauri::ipc::Channel;
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Listener, Manager, PhysicalPosition, State};
#[cfg(target_os = "macos")]
use tauri::ActivationPolicy;
use upload::{
    create_collection, delete_file, mark_collection_ready, upload_file, UploadProgress, UploadResult,
    init_batch, confirm_batch, upload_to_r2, upload_multipart_to_r2, get_batch_size,
    BatchFileRequest, BatchConfirmFile,
};
use chrono::Utc;
use uuid::Uuid;

struct AppState {
    config: Mutex<AppConfig>,
    /// Flag to signal upload cancellation - checked between files/chunks
    upload_cancelled: Arc<AtomicBool>,
}

/// Cancel any in-progress upload
#[tauri::command]
fn cancel_upload(state: State<AppState>) {
    eprintln!("[Upload] Cancel requested");
    state.upload_cancelled.store(true, Ordering::SeqCst);
}

/// Check if upload was cancelled
fn is_cancelled(cancel_flag: &Arc<AtomicBool>) -> bool {
    cancel_flag.load(Ordering::SeqCst)
}

/// Apply default expiry to an uploaded file/collection (fire and forget)
async fn apply_default_expiry(url: &str, is_collection: bool, days: u32) {
    // Extract file ID from URL (e.g., https://storage.to/abc123 or https://storage.to/c/abc123)
    let file_id = if is_collection {
        url.rsplit('/').next().unwrap_or("")
    } else {
        url.rsplit('/').next().unwrap_or("")
    };

    if file_id.is_empty() {
        return;
    }

    eprintln!("[Expiry] Applying default expiry of {} days to {}", days, file_id);
    match upload::set_expiry(file_id.to_string(), is_collection, days).await {
        Ok(()) => eprintln!("[Expiry] Default expiry applied successfully"),
        Err(e) => eprintln!("[Expiry] Failed to apply default expiry: {}", e),
    }
}

#[tauri::command]
async fn upload_single_file(
    path: String,
    on_progress: Channel<UploadProgress>,
    state: State<'_, AppState>,
) -> Result<UploadResult, String> {
    // Reset cancel flag at start of new upload
    state.upload_cancelled.store(false, Ordering::SeqCst);
    let cancel_flag = state.upload_cancelled.clone();

    // Check if cancelled before starting
    if is_cancelled(&cancel_flag) {
        return Err("Upload cancelled".to_string());
    }

    // Read default expiry before the await
    let default_expiry = state.config.lock().unwrap().default_expiry_days;

    let result = upload_file(path, None, on_progress, None).await?;

    // Apply default expiry if configured
    if let Some(days) = default_expiry {
        apply_default_expiry(&result.url, false, days).await;
        // Update local history to reflect the actual expiry
        let new_expires = Utc::now() + chrono::Duration::days(days as i64);
        let _ = storage::update_history_item_protection(&result.url, None, None, Some(new_expires));
    }

    Ok(result)
}

const CONCURRENT_UPLOADS: usize = 6;

/// File info for batch processing
struct FileInfo {
    path: String,
    filename: String,
    size: u64,
    content_type: String,
    file_id: String,
}

/// Work item for batch upload workers - handles both single and multipart uploads
enum BatchWorkItem {
    Single {
        idx: usize,
        file_info: FileInfo,
        upload_url: String,
        r2_key: String,
    },
    Multipart {
        idx: usize,
        file_info: FileInfo,
        upload_id: String,
        initial_urls: std::collections::HashMap<String, String>,
        r2_key: String,
    },
}

#[tauri::command]
async fn upload_files(
    paths: Vec<String>,
    on_progress: Channel<UploadProgress>,
    state: State<'_, AppState>,
) -> Result<Vec<UploadResult>, String> {
    // Reset cancel flag at start of new upload
    state.upload_cancelled.store(false, Ordering::SeqCst);
    let cancel_flag = state.upload_cancelled.clone();

    // Read default expiry before the await
    let default_expiry = state.config.lock().unwrap().default_expiry_days;

    // Single file - upload directly (no batch needed)
    if paths.len() == 1 {
        if is_cancelled(&cancel_flag) {
            return Err("Upload cancelled".to_string());
        }
        let result = upload_file(paths[0].clone(), None, on_progress, None).await?;

        // Apply default expiry if configured
        if let Some(days) = default_expiry {
            apply_default_expiry(&result.url, false, days).await;
            let new_expires = Utc::now() + chrono::Duration::days(days as i64);
            let _ = storage::update_history_item_protection(&result.url, None, None, Some(new_expires));
        }

        return Ok(vec![result]);
    }

    // Multiple files - use batch upload
    let results = upload_files_batch(paths, on_progress, cancel_flag).await?;

    // Apply default expiry to the collection if configured
    if let Some(days) = default_expiry {
        if let Some(last) = results.last() {
            if last.is_collection {
                apply_default_expiry(&last.url, true, days).await;
                let new_expires = Utc::now() + chrono::Duration::days(days as i64);
                let _ = storage::update_history_item_protection(&last.url, None, None, Some(new_expires));
            }
        }
    }

    Ok(results)
}

/// Upload multiple files using batch API endpoints (much more efficient)
/// This uses init-batch and confirm-batch to minimize API calls
async fn upload_files_batch(
    paths: Vec<String>,
    on_progress: Channel<UploadProgress>,
    cancel_flag: Arc<AtomicBool>,
) -> Result<Vec<UploadResult>, String> {
    let batch_size = get_batch_size();

    // Check cancellation at start
    if is_cancelled(&cancel_flag) {
        return Err("Upload cancelled".to_string());
    }

    // Generate a temporary collection ID for UI grouping before API call
    let temp_collection_id = Uuid::new_v4().to_string();
    let collection_name = format!("{} files", paths.len());

    // Step 1: Collect all file metadata and send queued status
    let mut file_infos: Vec<FileInfo> = Vec::new();

    for path in &paths {
        let p = Path::new(path);
        let filename = p.file_name().and_then(|n| n.to_str()).unwrap_or("unknown").to_string();
        let size = fs::metadata(path).map(|m| m.len()).unwrap_or(0);
        let content_type = mime_guess::from_path(p).first_or_octet_stream().to_string();
        let file_id = Uuid::new_v4().to_string();

        let _ = on_progress.send(UploadProgress {
            file_id: file_id.clone(),
            filename: filename.clone(),
            bytes_uploaded: 0,
            total_bytes: size,
            percentage: 0.0,
            status: "queued".to_string(),
            collection_id: Some(temp_collection_id.clone()),
            collection_name: Some(collection_name.clone()),
        });

        file_infos.push(FileInfo {
            path: path.clone(),
            filename,
            size,
            content_type,
            file_id,
        });
    }

    // Step 2: Create collection
    let collection = create_collection(Some(paths.len())).await?;
    let collection_id = collection.id.clone();

    // Use the same temp_collection_id for ALL progress events (UI grouping only)
    // The real collection_id is only used for API calls
    let collection_id_for_progress = temp_collection_id.clone();

    eprintln!("[Batch] Created collection {} for {} files", collection_id, file_infos.len());

    // Step 3: Process files in batches of 250
    let mut all_results: Vec<UploadResult> = Vec::new();
    let mut collection_files: Vec<CollectionFileItem> = Vec::new();
    let mut total_size: u64 = 0;

    for (batch_index, batch) in file_infos.chunks(batch_size).enumerate() {
        // Check cancellation before each batch
        if is_cancelled(&cancel_flag) {
            eprintln!("[Batch] Upload cancelled before batch {}", batch_index + 1);
            return Err("Upload cancelled".to_string());
        }

        eprintln!("[Batch] Processing batch {} ({} files)", batch_index + 1, batch.len());

        // Step 3a: Init batch - get presigned URLs for all files in this batch
        let init_requests: Vec<BatchFileRequest> = batch.iter().map(|f| BatchFileRequest {
            filename: f.filename.clone(),
            content_type: f.content_type.clone(),
            size: f.size,
        }).collect();

        let init_results = init_batch(init_requests).await?;

        // Step 3b: Upload files to R2 in parallel (using presigned URLs or multipart)
        let on_progress = Arc::new(on_progress.clone());
        let (tx, rx) = tokio::sync::mpsc::channel::<BatchWorkItem>(batch.len());
        let rx = Arc::new(tokio::sync::Mutex::new(rx));

        // Build work items with init results
        for (idx, file_info) in batch.iter().enumerate() {
            let idx_str = idx.to_string();
            if let Some(init_result) = init_results.get(&idx_str) {
                let fi = FileInfo {
                    path: file_info.path.clone(),
                    filename: file_info.filename.clone(),
                    size: file_info.size,
                    content_type: file_info.content_type.clone(),
                    file_id: file_info.file_id.clone(),
                };
                if let (Some(upload_url), Some(r2_key)) = (&init_result.upload_url, &init_result.r2_key) {
                    let _ = tx.send(BatchWorkItem::Single {
                        idx, file_info: fi, upload_url: upload_url.clone(), r2_key: r2_key.clone(),
                    }).await;
                } else if let (Some(upload_id), Some(r2_key)) = (&init_result.upload_id, &init_result.r2_key) {
                    let _ = tx.send(BatchWorkItem::Multipart {
                        idx, file_info: fi, upload_id: upload_id.clone(),
                        initial_urls: init_result.initial_urls.clone().unwrap_or_default(),
                        r2_key: r2_key.clone(),
                    }).await;
                } else {
                    eprintln!("[Batch] Missing URL/key for file {}: {:?}", idx, init_result.error);
                }
            }
        }
        drop(tx);

        // Spawn workers to upload to R2
        let mut handles = Vec::new();
        for _ in 0..CONCURRENT_UPLOADS {
            let rx = rx.clone();
            let progress = on_progress.clone();
            let coll_id = collection_id_for_progress.clone();
            let coll_name = collection_name.clone();
            let cancel = cancel_flag.clone();

            handles.push(tokio::spawn(async move {
                let mut uploaded: Vec<(usize, String, String, String, u64, u32)> = Vec::new(); // (idx, filename, content_type, r2_key, size, crc32)
                loop {
                    // Check cancellation before processing next file
                    if cancel.load(Ordering::SeqCst) {
                        eprintln!("[Batch] Worker detected cancellation");
                        break;
                    }

                    let item = {
                        let mut rx = rx.lock().await;
                        rx.recv().await
                    };
                    let item = match item {
                        Some(item) => item,
                        None => break,
                    };

                    // Extract common fields
                    let (idx, file_info, r2_key) = match &item {
                        BatchWorkItem::Single { idx, file_info, r2_key, .. } |
                        BatchWorkItem::Multipart { idx, file_info, r2_key, .. } => (
                            *idx,
                            FileInfo {
                                path: file_info.path.clone(),
                                filename: file_info.filename.clone(),
                                size: file_info.size,
                                content_type: file_info.content_type.clone(),
                                file_id: file_info.file_id.clone(),
                            },
                            r2_key.clone(),
                        ),
                    };

                    // Check cancellation again before starting upload
                    if cancel.load(Ordering::SeqCst) {
                        eprintln!("[Batch] Upload of {} cancelled", file_info.filename);
                        let _ = progress.send(UploadProgress {
                            file_id: file_info.file_id.clone(),
                            filename: file_info.filename.clone(),
                            bytes_uploaded: 0,
                            total_bytes: file_info.size,
                            percentage: 0.0,
                            status: "cancelled".to_string(),
                            collection_id: Some(coll_id.clone()),
                            collection_name: Some(coll_name.clone()),
                        });
                        break;
                    }

                    let path = Path::new(&file_info.path);

                    // Update status to uploading
                    let _ = progress.send(UploadProgress {
                        file_id: file_info.file_id.clone(),
                        filename: file_info.filename.clone(),
                        bytes_uploaded: 0,
                        total_bytes: file_info.size,
                        percentage: 0.0,
                        status: "uploading".to_string(),
                        collection_id: Some(coll_id.clone()),
                        collection_name: Some(coll_name.clone()),
                    });

                    // Upload to R2 (single or multipart)
                    let upload_result = match item {
                        BatchWorkItem::Single { upload_url, .. } => {
                            upload_to_r2(
                                path, &upload_url,
                                &file_info.file_id, &file_info.filename, file_info.size,
                                &progress, Some(coll_id.clone()), Some(coll_name.clone()),
                            ).await
                        }
                        BatchWorkItem::Multipart { upload_id, initial_urls, .. } => {
                            upload_multipart_to_r2(
                                path, &upload_id, &r2_key, file_info.size, initial_urls,
                                &file_info.file_id, &file_info.filename, &progress,
                                Some(coll_id.clone()), Some(coll_name.clone()),
                            ).await
                        }
                    };

                    match upload_result {
                        Ok(crc) => {
                            let _ = progress.send(UploadProgress {
                                file_id: file_info.file_id.clone(),
                                filename: file_info.filename.clone(),
                                bytes_uploaded: file_info.size,
                                total_bytes: file_info.size,
                                percentage: 100.0,
                                status: "confirming".to_string(),
                                collection_id: Some(coll_id.clone()),
                                collection_name: Some(coll_name.clone()),
                            });
                            uploaded.push((idx, file_info.filename, file_info.content_type, r2_key, file_info.size, crc));
                        }
                        Err(e) => {
                            eprintln!("[Batch] Failed to upload {}: {}", file_info.filename, e);
                            let _ = progress.send(UploadProgress {
                                file_id: file_info.file_id.clone(),
                                filename: file_info.filename.clone(),
                                bytes_uploaded: 0,
                                total_bytes: file_info.size,
                                percentage: 0.0,
                                status: "error".to_string(),
                                collection_id: Some(coll_id.clone()),
                                collection_name: Some(coll_name.clone()),
                            });
                        }
                    }
                }
                uploaded
            }));
        }

        // Collect uploaded files
        let mut uploaded_files: Vec<BatchConfirmFile> = Vec::new();
        let mut batch_uploaded: Vec<(String, u64)> = Vec::new(); // (filename, size)

        for handle in handles {
            match handle.await {
                Ok(results) => {
                    for (_, filename, content_type, r2_key, size, crc) in results {
                        uploaded_files.push(BatchConfirmFile {
                            filename: filename.clone(),
                            size,
                            content_type,
                            r2_key,
                            crc32: Some(crc as u64),
                        });
                        batch_uploaded.push((filename, size));
                    }
                }
                Err(e) => eprintln!("[Batch] Worker error: {}", e),
            }
        }

        // Step 3c: Confirm batch
        if !uploaded_files.is_empty() {
            let confirm_results = confirm_batch(Some(collection_id.clone()), uploaded_files).await?;

            // Process confirm results
            for (idx_str, result) in confirm_results {
                if result.success {
                    if let Some(file) = result.file {
                        if let Ok(idx) = idx_str.parse::<usize>() {
                            if idx < batch_uploaded.len() {
                                let (filename, size) = &batch_uploaded[idx];
                                total_size += size;

                                collection_files.push(CollectionFileItem {
                                    id: file.id.clone(),
                                    filename: filename.clone(),
                                    url: file.url.clone(),
                                    size: *size,
                                });

                                all_results.push(UploadResult {
                                    url: file.url,
                                    filename: filename.clone(),
                                    size: *size,
                                    is_collection: false,
                                    file_count: None,
                                });
                            }
                        }
                    }
                }
            }
        }
    }

    // Check if upload was cancelled and no files were uploaded
    let file_count = all_results.len() as u32;
    if file_count == 0 {
        // Delete the empty collection from API
        eprintln!("[Batch] No files uploaded, deleting empty collection {}", collection_id);
        let _ = delete_file(collection_id.clone(), true).await;
        return Err("Upload cancelled".to_string());
    }

    // Step 4: Mark collection ready
    let final_collection = mark_collection_ready(collection_id.clone()).await?;

    // Step 5: Add to history (only if files were uploaded)
    let expires_at = final_collection.expires_at.as_ref().and_then(|s| {
        chrono::DateTime::parse_from_rfc3339(s)
            .ok()
            .map(|dt| dt.with_timezone(&Utc))
    });

    let history_item = UploadHistoryItem {
        id: Uuid::new_v4().to_string(),
        filename: format!("{} files", file_count),
        url: final_collection.url.clone(),
        size: total_size,
        uploaded_at: Utc::now(),
        is_collection: true,
        file_count: Some(file_count),
        files: Some(collection_files.clone()),
        password_protected: None,
        burn_after_reading: None,
        expires_at,
        thumbnail_url: None,
    };
    let _ = add_to_history(history_item);

    // Send complete status for uploaded files only
    for file_info in &file_infos {
        // Only mark as complete if the file was actually uploaded
        if collection_files.iter().any(|f| f.filename == file_info.filename) {
            let _ = on_progress.send(UploadProgress {
                file_id: file_info.file_id.clone(),
                filename: file_info.filename.clone(),
                bytes_uploaded: file_info.size,
                total_bytes: file_info.size,
                percentage: 100.0,
                status: "complete".to_string(),
                collection_id: Some(collection_id.clone()),
                collection_name: Some(collection_name.clone()),
            });
        }
    }

    // Return individual file results + collection result (last entry)
    all_results.push(UploadResult {
        url: final_collection.url,
        filename: collection_name,
        size: total_size,
        is_collection: true,
        file_count: Some(file_count),
    });

    Ok(all_results)
}

#[tauri::command]
async fn upload_folder(
    folder_path: String,
    on_progress: Channel<UploadProgress>,
    state: State<'_, AppState>,
) -> Result<UploadResult, String> {
    // Reset cancel flag at start of new upload
    state.upload_cancelled.store(false, Ordering::SeqCst);
    let cancel_flag = state.upload_cancelled.clone();

    // Read default expiry before the await
    let default_expiry = state.config.lock().unwrap().default_expiry_days;

    let path = Path::new(&folder_path);

    // Check if it's a regular file first (DMG, ISO, etc. can appear as directories on macOS)
    if path.is_file() {
        return Err("Path is a file, not a directory".to_string());
    }

    if !path.is_dir() {
        return Err("Path is not a directory".to_string());
    }

    // Skip disk images and other archive-like files that macOS might treat as folders
    let extension = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
    if ["dmg", "iso", "img", "sparseimage", "sparsebundle"].contains(&extension.as_str()) {
        return Err("Path is a disk image file".to_string());
    }

    let folder_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("Collection")
        .to_string();

    let files = collect_files(path)?;

    if files.is_empty() {
        return Err("No files found in folder".to_string());
    }

    // Use batch upload (reusing the same logic as upload_files)
    let batch_size = get_batch_size();

    // Generate a temporary collection ID for UI grouping before API call
    let temp_collection_id = Uuid::new_v4().to_string();

    // Step 1: Collect all file metadata and send queued status
    let mut file_infos: Vec<FileInfo> = Vec::new();

    for file_path in &files {
        let p = Path::new(file_path);
        let filename = p.file_name().and_then(|n| n.to_str()).unwrap_or("unknown").to_string();
        let size = fs::metadata(file_path).map(|m| m.len()).unwrap_or(0);
        let content_type = mime_guess::from_path(p).first_or_octet_stream().to_string();
        let file_id = Uuid::new_v4().to_string();

        let _ = on_progress.send(UploadProgress {
            file_id: file_id.clone(),
            filename: filename.clone(),
            bytes_uploaded: 0,
            total_bytes: size,
            percentage: 0.0,
            status: "queued".to_string(),
            collection_id: Some(temp_collection_id.clone()),
            collection_name: Some(folder_name.clone()),
        });

        file_infos.push(FileInfo {
            path: file_path.clone(),
            filename,
            size,
            content_type,
            file_id,
        });
    }

    // Step 2: Create collection
    let collection = create_collection(Some(files.len())).await?;
    let collection_id = collection.id.clone();

    // Use the same temp_collection_id for ALL progress events (UI grouping only)
    let collection_id_for_progress = temp_collection_id.clone();

    eprintln!("[Batch] Created collection {} for folder '{}' ({} files)", collection_id, folder_name, file_infos.len());

    // Step 3: Process files in batches
    let mut collection_files: Vec<CollectionFileItem> = Vec::new();
    let mut total_size: u64 = 0;
    let mut success_count: u32 = 0;

    for (batch_index, batch) in file_infos.chunks(batch_size).enumerate() {
        // Check cancellation before each batch
        if is_cancelled(&cancel_flag) {
            eprintln!("[Batch] Folder upload cancelled before batch {}", batch_index + 1);
            return Err("Upload cancelled".to_string());
        }

        eprintln!("[Batch] Processing batch {} ({} files)", batch_index + 1, batch.len());

        // Init batch
        let init_requests: Vec<BatchFileRequest> = batch.iter().map(|f| BatchFileRequest {
            filename: f.filename.clone(),
            content_type: f.content_type.clone(),
            size: f.size,
        }).collect();

        let init_results = init_batch(init_requests).await?;

        // Upload to R2 in parallel (single or multipart)
        let on_progress = Arc::new(on_progress.clone());
        let (tx, rx) = tokio::sync::mpsc::channel::<BatchWorkItem>(batch.len());
        let rx = Arc::new(tokio::sync::Mutex::new(rx));

        for (idx, file_info) in batch.iter().enumerate() {
            let idx_str = idx.to_string();
            if let Some(init_result) = init_results.get(&idx_str) {
                let fi = FileInfo {
                    path: file_info.path.clone(),
                    filename: file_info.filename.clone(),
                    size: file_info.size,
                    content_type: file_info.content_type.clone(),
                    file_id: file_info.file_id.clone(),
                };
                if let (Some(upload_url), Some(r2_key)) = (&init_result.upload_url, &init_result.r2_key) {
                    let _ = tx.send(BatchWorkItem::Single {
                        idx, file_info: fi, upload_url: upload_url.clone(), r2_key: r2_key.clone(),
                    }).await;
                } else if let (Some(upload_id), Some(r2_key)) = (&init_result.upload_id, &init_result.r2_key) {
                    let _ = tx.send(BatchWorkItem::Multipart {
                        idx, file_info: fi, upload_id: upload_id.clone(),
                        initial_urls: init_result.initial_urls.clone().unwrap_or_default(),
                        r2_key: r2_key.clone(),
                    }).await;
                } else {
                    eprintln!("[Batch] Missing URL/key for file {}: {:?}", idx, init_result.error);
                }
            }
        }
        drop(tx);

        // Spawn workers
        let mut handles = Vec::new();
        for _ in 0..CONCURRENT_UPLOADS {
            let rx = rx.clone();
            let progress = on_progress.clone();
            let coll_id = collection_id_for_progress.clone();
            let coll_name = folder_name.clone();
            let cancel = cancel_flag.clone();

            handles.push(tokio::spawn(async move {
                let mut uploaded: Vec<(usize, String, String, String, u64, u32)> = Vec::new();
                loop {
                    if cancel.load(Ordering::SeqCst) {
                        eprintln!("[Batch] Folder worker detected cancellation");
                        break;
                    }

                    let item = {
                        let mut rx = rx.lock().await;
                        rx.recv().await
                    };
                    let item = match item {
                        Some(item) => item,
                        None => break,
                    };

                    let (idx, file_info, r2_key) = match &item {
                        BatchWorkItem::Single { idx, file_info, r2_key, .. } |
                        BatchWorkItem::Multipart { idx, file_info, r2_key, .. } => (
                            *idx,
                            FileInfo {
                                path: file_info.path.clone(),
                                filename: file_info.filename.clone(),
                                size: file_info.size,
                                content_type: file_info.content_type.clone(),
                                file_id: file_info.file_id.clone(),
                            },
                            r2_key.clone(),
                        ),
                    };

                    if cancel.load(Ordering::SeqCst) {
                        eprintln!("[Batch] Upload of {} cancelled", file_info.filename);
                        let _ = progress.send(UploadProgress {
                            file_id: file_info.file_id.clone(),
                            filename: file_info.filename.clone(),
                            bytes_uploaded: 0,
                            total_bytes: file_info.size,
                            percentage: 0.0,
                            status: "cancelled".to_string(),
                            collection_id: Some(coll_id.clone()),
                            collection_name: Some(coll_name.clone()),
                        });
                        break;
                    }

                    let path = Path::new(&file_info.path);

                    let _ = progress.send(UploadProgress {
                        file_id: file_info.file_id.clone(),
                        filename: file_info.filename.clone(),
                        bytes_uploaded: 0,
                        total_bytes: file_info.size,
                        percentage: 0.0,
                        status: "uploading".to_string(),
                        collection_id: Some(coll_id.clone()),
                        collection_name: Some(coll_name.clone()),
                    });

                    let upload_result = match item {
                        BatchWorkItem::Single { upload_url, .. } => {
                            upload_to_r2(
                                path, &upload_url,
                                &file_info.file_id, &file_info.filename, file_info.size,
                                &progress, Some(coll_id.clone()), Some(coll_name.clone()),
                            ).await
                        }
                        BatchWorkItem::Multipart { upload_id, initial_urls, .. } => {
                            upload_multipart_to_r2(
                                path, &upload_id, &r2_key, file_info.size, initial_urls,
                                &file_info.file_id, &file_info.filename, &progress,
                                Some(coll_id.clone()), Some(coll_name.clone()),
                            ).await
                        }
                    };

                    match upload_result {
                        Ok(crc) => {
                            let _ = progress.send(UploadProgress {
                                file_id: file_info.file_id.clone(),
                                filename: file_info.filename.clone(),
                                bytes_uploaded: file_info.size,
                                total_bytes: file_info.size,
                                percentage: 100.0,
                                status: "confirming".to_string(),
                                collection_id: Some(coll_id.clone()),
                                collection_name: Some(coll_name.clone()),
                            });
                            uploaded.push((idx, file_info.filename, file_info.content_type, r2_key, file_info.size, crc));
                        }
                        Err(e) => {
                            eprintln!("[Batch] Failed to upload {}: {}", file_info.filename, e);
                            let _ = progress.send(UploadProgress {
                                file_id: file_info.file_id.clone(),
                                filename: file_info.filename.clone(),
                                bytes_uploaded: 0,
                                total_bytes: file_info.size,
                                percentage: 0.0,
                                status: "error".to_string(),
                                collection_id: Some(coll_id.clone()),
                                collection_name: Some(coll_name.clone()),
                            });
                        }
                    }
                }
                uploaded
            }));
        }

        // Collect uploaded files
        let mut uploaded_files: Vec<BatchConfirmFile> = Vec::new();
        let mut batch_uploaded: Vec<(String, u64)> = Vec::new();

        for handle in handles {
            match handle.await {
                Ok(results) => {
                    for (_, filename, content_type, r2_key, size, crc) in results {
                        uploaded_files.push(BatchConfirmFile {
                            filename: filename.clone(),
                            size,
                            content_type,
                            r2_key,
                            crc32: Some(crc as u64),
                        });
                        batch_uploaded.push((filename, size));
                    }
                }
                Err(e) => eprintln!("[Batch] Worker error: {}", e),
            }
        }

        // Confirm batch
        if !uploaded_files.is_empty() {
            let confirm_results = confirm_batch(Some(collection_id.clone()), uploaded_files).await?;

            for (idx_str, result) in confirm_results {
                if result.success {
                    if let Some(file) = result.file {
                        if let Ok(idx) = idx_str.parse::<usize>() {
                            if idx < batch_uploaded.len() {
                                let (filename, size) = &batch_uploaded[idx];
                                total_size += size;
                                success_count += 1;

                                collection_files.push(CollectionFileItem {
                                    id: file.id.clone(),
                                    filename: filename.clone(),
                                    url: file.url.clone(),
                                    size: *size,
                                });
                            }
                        }
                    }
                }
            }
        }
    }

    // Check if upload was cancelled and no files were uploaded
    if success_count == 0 {
        // Delete the empty collection from API
        eprintln!("[Batch] No files uploaded to folder, deleting empty collection {}", collection_id);
        let _ = delete_file(collection_id.clone(), true).await;
        return Err("Upload cancelled".to_string());
    }

    // Mark collection ready
    let final_collection = mark_collection_ready(collection_id.clone()).await?;

    // Add to history (only if files were uploaded)
    let expires_at = final_collection.expires_at.as_ref().and_then(|s| {
        chrono::DateTime::parse_from_rfc3339(s)
            .ok()
            .map(|dt| dt.with_timezone(&Utc))
    });

    let history_item = UploadHistoryItem {
        id: Uuid::new_v4().to_string(),
        filename: folder_name.clone(),
        url: final_collection.url.clone(),
        size: total_size,
        uploaded_at: Utc::now(),
        is_collection: true,
        file_count: Some(success_count),
        files: Some(collection_files.clone()),
        password_protected: None,
        burn_after_reading: None,
        expires_at,
        thumbnail_url: None,
    };
    let _ = add_to_history(history_item);

    // Send complete status for uploaded files only
    for file_info in &file_infos {
        if collection_files.iter().any(|f| f.filename == file_info.filename) {
            let _ = on_progress.send(UploadProgress {
                file_id: file_info.file_id.clone(),
                filename: file_info.filename.clone(),
                bytes_uploaded: file_info.size,
                total_bytes: file_info.size,
                percentage: 100.0,
                status: "complete".to_string(),
                collection_id: Some(collection_id.clone()),
                collection_name: Some(folder_name.clone()),
            });
        }
    }

    let result = UploadResult {
        url: final_collection.url,
        filename: folder_name,
        size: total_size,
        is_collection: true,
        file_count: Some(success_count),
    };

    // Apply default expiry if configured
    if let Some(days) = default_expiry {
        apply_default_expiry(&result.url, true, days).await;
        let new_expires = Utc::now() + chrono::Duration::days(days as i64);
        let _ = storage::update_history_item_protection(&result.url, None, None, Some(new_expires));
    }

    Ok(result)
}

fn collect_files(dir: &Path) -> Result<Vec<String>, String> {
    let mut files = Vec::new();

    let entries = fs::read_dir(dir).map_err(|e| format!("Failed to read directory: {}", e))?;

    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed to read entry: {}", e))?;
        let path = entry.path();

        if path
            .file_name()
            .and_then(|n| n.to_str())
            .map(|s| s.starts_with('.'))
            .unwrap_or(false)
        {
            continue;
        }

        if path.is_dir() {
            files.extend(collect_files(&path)?);
        } else if path.is_file() {
            if let Some(path_str) = path.to_str() {
                files.push(path_str.to_string());
            }
        }
    }

    Ok(files)
}

#[tauri::command]
fn get_upload_history() -> Vec<UploadHistoryItem> {
    get_history()
}

#[tauri::command]
fn clear_upload_history() -> Result<(), String> {
    clear_history()
}

#[tauri::command]
fn set_history_thumbnail(url: String, thumbnail_url: String) -> Result<(), String> {
    storage::update_history_item_thumbnail(&url, &thumbnail_url)
}

#[tauri::command]
async fn delete_uploaded_file(file_id: String, url: String, is_collection: bool) -> Result<(), String> {
    // Delete from storage.to API
    delete_file(file_id, is_collection).await?;

    // Remove from local history
    remove_from_history(&url)?;

    Ok(())
}

#[tauri::command]
async fn set_file_password(file_id: String, is_collection: bool, password: String) -> Result<(), String> {
    upload::set_password(file_id, is_collection, password).await
}

#[tauri::command]
async fn set_file_expiry(file_id: String, is_collection: bool, days: u32) -> Result<(), String> {
    upload::set_expiry(file_id, is_collection, days).await
}

#[tauri::command]
async fn set_file_burn_after_reading(file_id: String, is_collection: bool) -> Result<(), String> {
    upload::set_burn_after_reading(file_id, is_collection).await
}

#[tauri::command]
async fn remove_file_password(file_id: String, is_collection: bool) -> Result<(), String> {
    upload::remove_password(file_id, is_collection).await
}

#[tauri::command]
async fn remove_file_burn_after_reading(file_id: String, is_collection: bool) -> Result<(), String> {
    upload::remove_burn_after_reading(file_id, is_collection).await
}

#[tauri::command]
fn update_history_protection(
    url: String,
    password_protected: Option<bool>,
    burn_after_reading: Option<bool>,
    expires_at: Option<String>,
) -> Result<(), String> {
    let expires_at_dt = expires_at.and_then(|s| {
        chrono::DateTime::parse_from_rfc3339(&s)
            .ok()
            .map(|dt| dt.with_timezone(&Utc))
    });
    storage::update_history_item_protection(&url, password_protected, burn_after_reading, expires_at_dt)
}

#[tauri::command]
fn get_config(state: State<AppState>) -> AppConfig {
    state.config.lock().unwrap().clone()
}

/// Take a screenshot using native OS tools
/// macOS: Uses `screencapture -i` for interactive region selection
/// Windows: Falls back to full-screen capture (for now)
#[tauri::command]
async fn take_screenshot() -> Result<String, String> {
    let timestamp = chrono::Local::now().format("%Y%m%d_%H%M%S");
    let filename = format!("screenshot_{}.png", timestamp);

    // Get temp directory for the screenshot
    let temp_dir = std::env::temp_dir();
    let screenshot_path = temp_dir.join(&filename);
    let path_str = screenshot_path.to_string_lossy().to_string();

    #[cfg(target_os = "macos")]
    {
        // Use native screencapture with interactive selection
        let output = std::process::Command::new("screencapture")
            .arg("-i")  // Interactive mode (region selection)
            .arg("-x")  // No sound
            .arg(&path_str)
            .output()
            .map_err(|e| format!("Failed to run screencapture: {}", e))?;

        if !output.status.success() {
            // User likely cancelled (pressed Escape)
            return Err("Screenshot cancelled".to_string());
        }

        // Check if file was actually created (user might have cancelled)
        if !screenshot_path.exists() {
            return Err("Screenshot cancelled".to_string());
        }
    }

    #[cfg(target_os = "windows")]
    {
        // Launch Windows Snip & Sketch overlay, then poll clipboard for the result
        let ps_script = format!(
            r#"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Clipboard]::Clear()
Start-Process "ms-screenclip:"
$elapsed = 0
while ($elapsed -lt 120) {{
    Start-Sleep -Milliseconds 500
    $elapsed += 0.5
    if ([System.Windows.Forms.Clipboard]::ContainsImage()) {{
        $img = [System.Windows.Forms.Clipboard]::GetImage()
        $img.Save("{}", [System.Drawing.Imaging.ImageFormat]::Png)
        exit 0
    }}
}}
exit 1
"#,
            path_str.replace("\\", "\\\\")
        );

        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;

        let output = std::process::Command::new("powershell")
            .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", &ps_script])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map_err(|e| format!("Failed to run screenshot tool: {}", e))?;

        if !output.status.success() || !screenshot_path.exists() {
            return Err("Screenshot cancelled".to_string());
        }
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        return Err("Screenshots not supported on this platform".to_string());
    }

    Ok(path_str)
}

#[tauri::command]
fn update_config(state: State<AppState>, config: AppConfig) -> Result<(), String> {
    let mut current = state.config.lock().unwrap();
    *current = config.clone();
    save_config(&config)
}

/// Get the visitor token from Rust storage (exposes to frontend)
#[tauri::command]
fn get_visitor_token_command() -> Option<String> {
    get_visitor_token()
}

/// Restart the app to apply a pending update
#[tauri::command]
fn restart_app(app: AppHandle) {
    eprintln!("[Updater] Restarting app to apply update");
    app.restart();
}

/// Check if autostart is enabled
#[tauri::command]
fn get_autostart_enabled(app: AppHandle) -> bool {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().unwrap_or(false)
}

/// Enable or disable autostart
#[tauri::command]
fn set_autostart_enabled(app: AppHandle, enabled: bool) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;
    let autolaunch = app.autolaunch();
    if enabled {
        autolaunch.enable().map_err(|e| format!("Failed to enable autostart: {}", e))
    } else {
        autolaunch.disable().map_err(|e| format!("Failed to disable autostart: {}", e))
    }
}

/// Get current screenshot shortcut string
#[tauri::command]
fn get_screenshot_shortcut(state: State<AppState>) -> Option<String> {
    state.config.lock().unwrap().screenshot_shortcut.clone()
}

/// Update the screenshot shortcut: unregister old, register new, save to config
#[tauri::command]
fn update_screenshot_shortcut(
    app: AppHandle,
    state: State<AppState>,
    shortcut: String,
) -> Result<(), String> {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;

    // Parse the new shortcut to validate it
    let new_shortcut = shortcut
        .parse::<tauri_plugin_global_shortcut::Shortcut>()
        .map_err(|e| format!("Invalid shortcut: {}", e))?;

    // Unregister all existing shortcuts
    let _ = app.global_shortcut().unregister_all();

    // Register the new shortcut
    let app_handle = app.clone();
    app.global_shortcut()
        .on_shortcut(new_shortcut, move |_app, _scut, event| {
            if event.state == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                let _ = app_handle.emit("screenshot-requested", ());
            }
        })
        .map_err(|e| format!("Failed to register shortcut: {}", e))?;

    // Save to config
    let mut config = state.config.lock().unwrap();
    config.screenshot_shortcut = Some(shortcut);
    save_config(&config).map_err(|e| format!("Failed to save config: {}", e))?;

    Ok(())
}

/// Get auth status (and user info if logged in)
#[tauri::command]
async fn get_auth_status(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let auth_token = {
        let config = state.config.lock().unwrap();
        config.auth_token.clone()
    };

    let Some(token) = auth_token else {
        return Ok(serde_json::json!({ "logged_in": false }));
    };

    // Fetch user info from API
    let api_url = get_api_url();
    let client = reqwest::Client::new();
    let response = client
        .get(format!("{}/api/user", api_url))
        .header("Authorization", format!("Bearer {}", token))
        .header("Accept", "application/json")
        .send()
        .await;

    match response {
        Ok(resp) if resp.status().is_success() => {
            if let Ok(user) = resp.json::<serde_json::Value>().await {
                return Ok(serde_json::json!({
                    "logged_in": true,
                    "email": user.get("email").and_then(|v| v.as_str()),
                    "name": user.get("name").and_then(|v| v.as_str()),
                }));
            }
        }
        Ok(resp) if resp.status().as_u16() == 401 => {
            // Token is invalid/expired — clear it
            let mut config = state.config.lock().unwrap();
            config.auth_token = None;
            let _ = save_config(&config);
            return Ok(serde_json::json!({ "logged_in": false }));
        }
        _ => {}
    }

    // API unreachable but we have a token — show logged in without details
    Ok(serde_json::json!({ "logged_in": true }))
}

/// Logout - revoke token on API then clear locally
#[tauri::command]
async fn logout(state: State<'_, AppState>) -> Result<(), String> {
    // Read token before clearing
    let auth_token = {
        let config = state.config.lock().unwrap();
        config.auth_token.clone()
    };

    // Revoke token on API (fire and forget)
    if let Some(token) = &auth_token {
        let api_url = get_api_url();
        let client = reqwest::Client::new();
        let _ = client
            .post(format!("{}/api/auth/logout", api_url))
            .header("Authorization", format!("Bearer {}", token))
            .header("Accept", "application/json")
            .send()
            .await;
    }

    // Clear locally
    let mut config = state.config.lock().unwrap();
    config.auth_token = None;
    save_config(&config)
}

/// Send analytics event to API
async fn send_analytics_event(event: &str, context: Option<serde_json::Value>) {
    let api_url = get_api_url();
    let visitor_token = get_visitor_token();
    let auth_token = get_auth_token();
    let version = env!("CARGO_PKG_VERSION");

    let client = reqwest::Client::new();
    let mut body = serde_json::json!({
        "app": "desktop",
        "version": version,
        "event": event,
    });

    if let Some(ctx) = context {
        body["context"] = ctx;
    }

    let mut request = client
        .post(format!("{}/api/app-analytics", api_url))
        .header("Accept", "application/json")
        .json(&body);

    if let Some(token) = visitor_token {
        request = request.header("X-Visitor-Token", token);
    }

    if let Some(token) = auth_token {
        request = request.header("Authorization", format!("Bearer {}", token));
    }

    // Fire and forget - we don't care about the result for heartbeats
    let _ = request.send().await;
}

/// Start the background heartbeat task using Tauri's async runtime
fn start_heartbeat_task() {
    // Use tauri::async_runtime::spawn instead of tokio::spawn
    // This properly integrates with Tauri's runtime during setup
    tauri::async_runtime::spawn(async {
        let interval_secs = 60 * 60; // 60 minutes
        loop {
            tokio::time::sleep(tokio::time::Duration::from_secs(interval_secs)).await;

            let os = if cfg!(target_os = "macos") {
                "macos"
            } else if cfg!(target_os = "windows") {
                "windows"
            } else {
                "linux"
            };

            send_analytics_event("heartbeat", Some(serde_json::json!({
                "os": os,
            }))).await;

            eprintln!("[Analytics] Heartbeat sent");
        }
    });
}

/// Start the background update checker task
fn start_update_checker(app_handle: AppHandle) {
    use tauri_plugin_updater::UpdaterExt;
    use tauri_plugin_notification::NotificationExt;

    tauri::async_runtime::spawn(async move {
        // Initial delay before first check (let app fully start)
        tokio::time::sleep(tokio::time::Duration::from_secs(10)).await;

        let check_interval_secs = 60 * 60; // Check every hour

        loop {
            eprintln!("[Updater] Checking for updates...");

            match app_handle.updater() {
                Ok(updater) => {
                    match updater.check().await {
                        Ok(Some(update)) => {
                            let version = update.version.clone();
                            eprintln!("[Updater] Update available: {}", version);

                            // Download the update in background
                            match update.download_and_install(|_, _| {}, || {}).await {
                                Ok(_) => {
                                    eprintln!("[Updater] Update downloaded, showing notification");

                                    // Show notification to user
                                    let _ = app_handle.notification()
                                        .builder()
                                        .title("Update Ready")
                                        .body(format!("StorageTo v{} downloaded. Restart to apply.", version))
                                        .show();

                                    // Emit event so frontend knows update is ready
                                    let _ = app_handle.emit("update-ready", version);
                                }
                                Err(e) => {
                                    eprintln!("[Updater] Failed to download update: {}", e);
                                }
                            }
                        }
                        Ok(None) => {
                            eprintln!("[Updater] No update available");
                        }
                        Err(e) => {
                            eprintln!("[Updater] Failed to check for updates: {}", e);
                        }
                    }
                }
                Err(e) => {
                    eprintln!("[Updater] Failed to get updater: {}", e);
                }
            }

            tokio::time::sleep(tokio::time::Duration::from_secs(check_interval_secs)).await;
        }
    });
}

// Screenshot is now handled via tauri-plugin-screenshots on the frontend

fn show_window_at_tray(app: &AppHandle, tray_x: f64, tray_y: f64, tray_width: f64, tray_height: f64) {
    if let Some(window) = app.get_webview_window("main") {
        // Get scale factor for proper HiDPI handling
        let scale_factor = window.scale_factor().unwrap_or(1.0);

        // Window dimensions in logical pixels
        let window_width = 380.0;
        let window_height = 580.0;

        // Convert tray position to logical if needed (Tauri sometimes returns physical coords)
        let logical_tray_x = tray_x / scale_factor;
        let logical_tray_y = tray_y / scale_factor;
        let logical_tray_width = tray_width / scale_factor;
        let logical_tray_height = tray_height / scale_factor;

        // Get monitor bounds for screen edge detection
        let (monitor_x, monitor_y, monitor_width, monitor_height) = window.current_monitor()
            .ok()
            .flatten()
            .map(|m| {
                let pos = m.position();
                let size = m.size();
                (
                    pos.x as f64 / scale_factor,
                    pos.y as f64 / scale_factor,
                    size.width as f64 / scale_factor,
                    size.height as f64 / scale_factor,
                )
            })
            .unwrap_or((0.0, 0.0, 1920.0, 1080.0));

        // Center horizontally on tray icon
        let tray_center_x = logical_tray_x + logical_tray_width / 2.0;
        let mut x = tray_center_x - window_width / 2.0;

        // Try positioning below tray first, fall back to above if off-screen
        // This handles macOS (top menu bar) and Windows (bottom taskbar)
        let y_below = logical_tray_y + logical_tray_height;
        let y_above = logical_tray_y - window_height;
        let y = if y_below + window_height > monitor_y + monitor_height {
            // Would go off bottom of screen, position above tray instead
            y_above
        } else {
            y_below
        };

        // Clamp X to stay within monitor bounds
        let monitor_right = monitor_x + monitor_width;
        if x + window_width > monitor_right {
            x = monitor_right - window_width;
        }
        if x < monitor_x {
            x = monitor_x;
        }

        // Convert back to physical pixels for set_position
        let physical_x = (x * scale_factor) as i32;
        let physical_y = (y * scale_factor) as i32;

        let _ = window.set_position(PhysicalPosition::new(physical_x, physical_y));
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn hide_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
}

fn toggle_window_simple(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
        } else {
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;

    let config = load_config();

    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_screenshots::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None))
        .plugin(tauri_plugin_deep_link::init());

    #[cfg(target_os = "macos")]
    {
        builder = builder.plugin(tauri_plugin_macos_permissions::init());
    }

    builder.manage(AppState {
            config: Mutex::new(config),
            upload_cancelled: Arc::new(AtomicBool::new(false)),
        })
        .setup(|app| {
            // Hide dock icon - this is a menu bar app only
            #[cfg(target_os = "macos")]
            app.set_activation_policy(ActivationPolicy::Accessory);

            // Build tray menu
            let show_item = MenuItemBuilder::with_id("show", "Show Window").build(app)?;
            let settings_item = MenuItemBuilder::with_id("settings", "Settings").build(app)?;
            let quit_item = MenuItemBuilder::with_id("quit", "Quit").build(app)?;

            let menu = MenuBuilder::new(app)
                .item(&show_item)
                .item(&settings_item)
                .separator()
                .item(&quit_item)
                .build()?;

            // Build tray icon
            // macOS: black icon + template mode (OS auto-inverts for dark mode)
            // Windows: white icon (taskbar is typically dark)
            #[cfg(target_os = "macos")]
            let tray_icon = tauri::include_image!("icons/tray.png");
            #[cfg(target_os = "windows")]
            let tray_icon = tauri::include_image!("icons/tray-windows.png");
            #[cfg(not(any(target_os = "macos", target_os = "windows")))]
            let tray_icon = tauri::include_image!("icons/tray.png");

            let tray = TrayIconBuilder::new()
                .icon(tray_icon)
                .icon_as_template(cfg!(target_os = "macos"))  // Only use template mode on macOS
                .menu(&menu)
                .show_menu_on_left_click(false)
                .tooltip("StorageTo - Click to upload")
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => toggle_window_simple(app),
                    "settings" => {
                        // Show window and emit event to open settings panel
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                        let _ = app.emit("open-settings", ());
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    match event {
                        TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            rect,
                            ..
                        } => {
                            let app = tray.app_handle();
                            if let Some(window) = app.get_webview_window("main") {
                                if window.is_visible().unwrap_or(false) {
                                    hide_window(app);
                                } else {
                                    // Get physical position and size from rect
                                    let (pos_x, pos_y) = match rect.position {
                                        tauri::Position::Physical(p) => (p.x as f64, p.y as f64),
                                        tauri::Position::Logical(l) => (l.x, l.y),
                                    };
                                    let (size_w, size_h) = match rect.size {
                                        tauri::Size::Physical(s) => (s.width as f64, s.height as f64),
                                        tauri::Size::Logical(l) => (l.width, l.height),
                                    };
                                    // Position window below tray icon
                                    show_window_at_tray(app, pos_x, pos_y, size_w, size_h);
                                }
                            }
                        }
                        _ => {}
                    }
                })
                .build(app)?;

            // Register global shortcut for screenshot (use config if set, else platform default)
            let config_shortcut = {
                let state: State<AppState> = app.state();
                let shortcut = state.config.lock().unwrap().screenshot_shortcut.clone();
                shortcut
            };

            #[cfg(target_os = "macos")]
            let default_shortcut = "Command+Shift+S";
            #[cfg(target_os = "windows")]
            let default_shortcut = "Control+Shift+S";
            #[cfg(not(any(target_os = "macos", target_os = "windows")))]
            let default_shortcut = "Control+Shift+S";

            let shortcut_str = config_shortcut.as_deref().unwrap_or(default_shortcut);

            let app_handle = app.handle().clone();
            if let Ok(shortcut) = shortcut_str.parse::<tauri_plugin_global_shortcut::Shortcut>() {
                let _ = app.global_shortcut().on_shortcut(shortcut, move |_app, _scut, event| {
                    if event.state == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        let _ = app_handle.emit("screenshot-requested", ());
                    }
                });
            } else {
                eprintln!("[Shortcut] Failed to parse shortcut: {}, falling back to default", shortcut_str);
                let shortcut = default_shortcut.parse::<tauri_plugin_global_shortcut::Shortcut>().unwrap();
                let _ = app.global_shortcut().on_shortcut(shortcut, move |_app, _scut, event| {
                    if event.state == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        let _ = app_handle.emit("screenshot-requested", ());
                    }
                });
            }

            // Show notification on first launch
            if check_first_launch() {
                use tauri_plugin_notification::NotificationExt;
                let _ = app.notification()
                    .builder()
                    .title("StorageTo is running!")
                    .body("Click the menu bar icon to upload files.")
                    .show();
            }

            // Handle deep links (storageto://auth?token=XXX)
            let deep_link_handle = app.handle().clone();
            app.listen("deep-link://new-url", move |event: tauri::Event| {
                let urls_str = event.payload();
                eprintln!("[DeepLink] Received: {}", urls_str);

                // Parse the payload - it's a JSON array of URL strings
                if let Ok(urls) = serde_json::from_str::<Vec<String>>(urls_str) {
                    for url_str in urls {
                        if let Ok(url) = url::Url::parse(&url_str) {
                            if url.scheme() == "storageto" && url.host_str() == Some("auth") {
                                // Extract token from query params
                                for (key, value) in url.query_pairs() {
                                    if key == "token" {
                                        eprintln!("[DeepLink] Auth token received");
                                        let token = value.to_string();

                                        // Save auth token to config
                                        let state: State<AppState> = deep_link_handle.state();
                                        let mut config = state.config.lock().unwrap();
                                        config.auth_token = Some(token.clone());
                                        let _ = save_config(&config);
                                        drop(config);

                                        // Show window and emit event
                                        if let Some(window) = deep_link_handle.get_webview_window("main") {
                                            let _ = window.show();
                                            let _ = window.set_focus();
                                        }
                                        let _ = deep_link_handle.emit("auth-token-received", ());
                                    }
                                }
                            }
                        }
                    }
                }
            });

            // Keep tray reference alive
            let _ = tray;

            // Start background heartbeat task (runs in Rust, not affected by window visibility)
            start_heartbeat_task();
            eprintln!("[Analytics] Background heartbeat started");

            // Start background update checker
            start_update_checker(app.handle().clone());
            eprintln!("[Updater] Background update checker started");

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            upload_single_file,
            upload_files,
            upload_folder,
            cancel_upload,
            get_upload_history,
            clear_upload_history,
            set_history_thumbnail,
            delete_uploaded_file,
            set_file_password,
            set_file_expiry,
            set_file_burn_after_reading,
            remove_file_password,
            remove_file_burn_after_reading,
            update_history_protection,
            get_config,
            update_config,
            take_screenshot,
            get_visitor_token_command,
            restart_app,
            get_autostart_enabled,
            set_autostart_enabled,
            get_screenshot_shortcut,
            update_screenshot_shortcut,
            get_auth_status,
            logout,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
