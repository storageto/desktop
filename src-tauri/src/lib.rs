mod storage;
mod upload;

use std::fs;
use std::path::Path;
use std::sync::Mutex;
use std::sync::Arc;

use storage::{
    clear_history, get_history, load_config, save_config, AppConfig, UploadHistoryItem,
    add_to_history, remove_from_history, CollectionFileItem, check_first_launch,
};
use tauri::ipc::Channel;
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, State};
#[cfg(target_os = "macos")]
use tauri::ActivationPolicy;
use upload::{
    create_collection, delete_file, mark_collection_ready, upload_file, UploadProgress, UploadResult,
    init_batch, confirm_batch, upload_to_r2, get_batch_size,
    BatchFileRequest, BatchConfirmFile,
};
use chrono::Utc;
use uuid::Uuid;

struct AppState {
    config: Mutex<AppConfig>,
}

#[tauri::command]
async fn upload_single_file(
    path: String,
    on_progress: Channel<UploadProgress>,
) -> Result<UploadResult, String> {
    upload_file(path, None, on_progress, None).await
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

#[tauri::command]
async fn upload_files(
    paths: Vec<String>,
    on_progress: Channel<UploadProgress>,
) -> Result<Vec<UploadResult>, String> {
    // Single file - upload directly (no batch needed)
    if paths.len() == 1 {
        let result = upload_file(paths[0].clone(), None, on_progress, None).await?;
        return Ok(vec![result]);
    }

    // Multiple files - use batch upload
    upload_files_batch(paths, on_progress).await
}

/// Upload multiple files using batch API endpoints (much more efficient)
/// This uses init-batch and confirm-batch to minimize API calls
async fn upload_files_batch(
    paths: Vec<String>,
    on_progress: Channel<UploadProgress>,
) -> Result<Vec<UploadResult>, String> {
    let batch_size = get_batch_size();

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
        eprintln!("[Batch] Processing batch {} ({} files)", batch_index + 1, batch.len());

        // Step 3a: Init batch - get presigned URLs for all files in this batch
        let init_requests: Vec<BatchFileRequest> = batch.iter().map(|f| BatchFileRequest {
            filename: f.filename.clone(),
            content_type: f.content_type.clone(),
            size: f.size,
        }).collect();

        let init_results = init_batch(init_requests).await?;

        // Step 3b: Upload files to R2 in parallel (using presigned URLs)
        let on_progress = Arc::new(on_progress.clone());
        let (tx, rx) = tokio::sync::mpsc::channel::<(usize, FileInfo, String, String)>(batch.len());
        let rx = Arc::new(tokio::sync::Mutex::new(rx));

        // Build work items with init results
        for (idx, file_info) in batch.iter().enumerate() {
            let idx_str = idx.to_string();
            if let Some(init_result) = init_results.get(&idx_str) {
                if let (Some(upload_url), Some(r2_key)) = (&init_result.upload_url, &init_result.r2_key) {
                    let _ = tx.send((idx, FileInfo {
                        path: file_info.path.clone(),
                        filename: file_info.filename.clone(),
                        size: file_info.size,
                        content_type: file_info.content_type.clone(),
                        file_id: file_info.file_id.clone(),
                    }, upload_url.clone(), r2_key.clone())).await;
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

            handles.push(tokio::spawn(async move {
                let mut uploaded: Vec<(usize, String, String, String, u64)> = Vec::new(); // (idx, filename, content_type, r2_key, size)
                loop {
                    let item = {
                        let mut rx = rx.lock().await;
                        rx.recv().await
                    };
                    match item {
                        Some((idx, file_info, upload_url, r2_key)) => {
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

                            // Upload to R2
                            match upload_to_r2(
                                path,
                                &upload_url,
                                &file_info.file_id,
                                &file_info.filename,
                                file_info.size,
                                &progress,
                                Some(coll_id.clone()),
                                Some(coll_name.clone()),
                            ).await {
                                Ok(()) => {
                                    // Mark this file as uploaded (confirming stage)
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
                                    uploaded.push((idx, file_info.filename, file_info.content_type, r2_key, file_info.size));
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
                        None => break,
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
                    for (_, filename, content_type, r2_key, size) in results {
                        uploaded_files.push(BatchConfirmFile {
                            filename: filename.clone(),
                            size,
                            content_type,
                            r2_key,
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

    // Step 4: Mark collection ready
    let final_collection = mark_collection_ready(collection_id.clone()).await?;

    // Step 5: Add to history
    let file_count = all_results.len() as u32;

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
        files: Some(collection_files),
        password_protected: None,
        burn_after_reading: None,
        expires_at,
    };
    let _ = add_to_history(history_item);

    // Send complete status for all files
    for file_info in &file_infos {
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

    // Return collection result
    let collection_result = UploadResult {
        url: final_collection.url,
        filename: collection_name,
        size: total_size,
        is_collection: true,
        file_count: Some(file_count),
    };

    Ok(vec![collection_result])
}

#[tauri::command]
async fn upload_folder(
    folder_path: String,
    on_progress: Channel<UploadProgress>,
) -> Result<UploadResult, String> {
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
        eprintln!("[Batch] Processing batch {} ({} files)", batch_index + 1, batch.len());

        // Init batch
        let init_requests: Vec<BatchFileRequest> = batch.iter().map(|f| BatchFileRequest {
            filename: f.filename.clone(),
            content_type: f.content_type.clone(),
            size: f.size,
        }).collect();

        let init_results = init_batch(init_requests).await?;

        // Upload to R2 in parallel
        let on_progress = Arc::new(on_progress.clone());
        let (tx, rx) = tokio::sync::mpsc::channel::<(usize, FileInfo, String, String)>(batch.len());
        let rx = Arc::new(tokio::sync::Mutex::new(rx));

        for (idx, file_info) in batch.iter().enumerate() {
            let idx_str = idx.to_string();
            if let Some(init_result) = init_results.get(&idx_str) {
                if let (Some(upload_url), Some(r2_key)) = (&init_result.upload_url, &init_result.r2_key) {
                    let _ = tx.send((idx, FileInfo {
                        path: file_info.path.clone(),
                        filename: file_info.filename.clone(),
                        size: file_info.size,
                        content_type: file_info.content_type.clone(),
                        file_id: file_info.file_id.clone(),
                    }, upload_url.clone(), r2_key.clone())).await;
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

            handles.push(tokio::spawn(async move {
                let mut uploaded: Vec<(usize, String, String, String, u64)> = Vec::new();
                loop {
                    let item = {
                        let mut rx = rx.lock().await;
                        rx.recv().await
                    };
                    match item {
                        Some((idx, file_info, upload_url, r2_key)) => {
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

                            match upload_to_r2(
                                path,
                                &upload_url,
                                &file_info.file_id,
                                &file_info.filename,
                                file_info.size,
                                &progress,
                                Some(coll_id.clone()),
                                Some(coll_name.clone()),
                            ).await {
                                Ok(()) => {
                                    // Mark this file as uploaded (confirming stage)
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
                                    uploaded.push((idx, file_info.filename, file_info.content_type, r2_key, file_info.size));
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
                        None => break,
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
                    for (_, filename, content_type, r2_key, size) in results {
                        uploaded_files.push(BatchConfirmFile {
                            filename: filename.clone(),
                            size,
                            content_type,
                            r2_key,
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

    // Mark collection ready
    let final_collection = mark_collection_ready(collection_id.clone()).await?;

    // Add to history
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
        files: Some(collection_files),
        password_protected: None,
        burn_after_reading: None,
        expires_at,
    };
    let _ = add_to_history(history_item);

    // Send complete status
    for file_info in &file_infos {
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

    Ok(UploadResult {
        url: final_collection.url,
        filename: folder_name,
        size: total_size,
        is_collection: true,
        file_count: Some(success_count),
    })
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
        // For Windows, use snippingtool /clip and read from clipboard
        // For now, fall back to error - we'll implement this later
        return Err("Region selection not yet supported on Windows. Use the full-screen capture.".to_string());
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

// Screenshot is now handled via tauri-plugin-screenshots on the frontend

fn show_window_at_tray(app: &AppHandle, tray_x: f64, tray_y: f64, tray_width: f64, tray_height: f64) {
    if let Some(window) = app.get_webview_window("main") {
        // Get scale factor for proper HiDPI handling
        let scale_factor = window.scale_factor().unwrap_or(1.0);

        // Window width in logical pixels
        let window_width = 380.0;

        // Convert tray position to logical if needed (Tauri sometimes returns physical coords)
        let logical_tray_x = tray_x / scale_factor;
        let logical_tray_y = tray_y / scale_factor;
        let logical_tray_width = tray_width / scale_factor;
        let logical_tray_height = tray_height / scale_factor;

        // Position window centered below tray icon (in logical pixels)
        let tray_center_x = logical_tray_x + logical_tray_width / 2.0;
        let x = tray_center_x - window_width / 2.0;

        // Position just below the menu bar
        let y = logical_tray_y + logical_tray_height;

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

    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_screenshots::init())
        .plugin(tauri_plugin_updater::Builder::new().build());

    #[cfg(target_os = "macos")]
    {
        builder = builder.plugin(tauri_plugin_macos_permissions::init());
    }

    builder.manage(AppState {
            config: Mutex::new(config),
        })
        .setup(|app| {
            // Hide dock icon - this is a menu bar app only
            #[cfg(target_os = "macos")]
            app.set_activation_policy(ActivationPolicy::Accessory);

            // Build tray menu
            let show_item = MenuItemBuilder::with_id("show", "Show Window").build(app)?;
            let quit_item = MenuItemBuilder::with_id("quit", "Quit").build(app)?;

            let menu = MenuBuilder::new(app)
                .item(&show_item)
                .separator()
                .item(&quit_item)
                .build()?;

            // Build tray icon
            // Load tray icon (monochrome for light/dark mode support)
            let tray = TrayIconBuilder::new()
                .icon(tauri::include_image!("icons/tray.png"))
                .icon_as_template(true)  // macOS will auto-invert for dark mode
                .menu(&menu)
                .show_menu_on_left_click(false)
                .tooltip("StorageTo - Click to upload")
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => toggle_window_simple(app),
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

            // Register global shortcut for screenshot
            #[cfg(target_os = "macos")]
            let shortcut_str = "Command+Shift+S";
            #[cfg(target_os = "windows")]
            let shortcut_str = "Control+Shift+S";
            #[cfg(not(any(target_os = "macos", target_os = "windows")))]
            let shortcut_str = "Control+Shift+S";

            let app_handle = app.handle().clone();
            let shortcut = shortcut_str.parse::<tauri_plugin_global_shortcut::Shortcut>().unwrap();

            let _ = app.global_shortcut().on_shortcut(shortcut, move |_app, _scut, event| {
                if event.state == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                    let _ = app_handle.emit("screenshot-requested", ());
                }
            });

            // Show notification on first launch
            if check_first_launch() {
                use tauri_plugin_notification::NotificationExt;
                let _ = app.notification()
                    .builder()
                    .title("StorageTo is running!")
                    .body("Click the menu bar icon to upload files.")
                    .show();
            }

            // Keep tray reference alive
            let _ = tray;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            upload_single_file,
            upload_files,
            upload_folder,
            get_upload_history,
            clear_upload_history,
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
