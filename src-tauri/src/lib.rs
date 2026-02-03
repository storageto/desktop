mod storage;
mod upload;

use std::fs;
use std::path::Path;
use std::sync::Mutex;
use std::sync::Arc;

use storage::{
    clear_history, get_history, load_config, save_config, AppConfig, UploadHistoryItem,
    add_to_history, remove_from_history, CollectionFileItem,
};
use tauri::ipc::Channel;
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, State, ActivationPolicy};
use upload::{create_collection, delete_file, mark_collection_ready, upload_file, UploadProgress, UploadResult};
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

#[tauri::command]
async fn upload_files(
    paths: Vec<String>,
    on_progress: Channel<UploadProgress>,
) -> Result<Vec<UploadResult>, String> {
    // Single file - upload directly
    if paths.len() == 1 {
        let result = upload_file(paths[0].clone(), None, on_progress, None).await?;
        return Ok(vec![result]);
    }

    // Multiple files - generate file_ids and send queued status for all files first
    let mut file_infos: Vec<(String, String)> = Vec::new(); // (path, file_id)

    for path in &paths {
        let p = Path::new(path);
        let filename = p.file_name().and_then(|n| n.to_str()).unwrap_or("unknown").to_string();
        let size = fs::metadata(path).map(|m| m.len()).unwrap_or(0);
        let file_id = Uuid::new_v4().to_string();

        let _ = on_progress.send(UploadProgress {
            file_id: file_id.clone(),
            filename,
            bytes_uploaded: 0,
            total_bytes: size,
            percentage: 0.0,
            status: "queued".to_string(),
        });

        file_infos.push((path.clone(), file_id));
    }

    // Create a collection
    let collection = create_collection(Some(paths.len())).await?;
    let collection_id = Arc::new(collection.id.clone());
    let on_progress = Arc::new(on_progress);

    // Use a channel-based work queue (pull-based like web app)
    let (tx, rx) = tokio::sync::mpsc::channel::<(String, String)>(file_infos.len());
    let rx = Arc::new(tokio::sync::Mutex::new(rx));

    // Send all work items to the queue
    for item in file_infos {
        let _ = tx.send(item).await;
    }
    drop(tx); // Close sender so workers know when done

    // Spawn worker tasks
    let mut handles = Vec::new();
    for _ in 0..CONCURRENT_UPLOADS {
        let rx = rx.clone();
        let coll_id = collection_id.clone();
        let progress = on_progress.clone();

        handles.push(tokio::spawn(async move {
            let mut results: Vec<UploadResult> = Vec::new();
            loop {
                let item = {
                    let mut rx = rx.lock().await;
                    rx.recv().await
                };
                match item {
                    Some((path, file_id)) => {
                        match upload_file(path, Some((*coll_id).clone()), (*progress).clone(), Some(file_id)).await {
                            Ok(r) => results.push(r),
                            Err(e) => eprintln!("Failed to upload file: {}", e),
                        }
                    }
                    None => break, // Channel closed, no more work
                }
            }
            results
        }));
    }

    // Collect results from all workers
    let mut results = Vec::new();
    let mut total_size: u64 = 0;
    let mut collection_files: Vec<CollectionFileItem> = Vec::new();

    for handle in handles {
        match handle.await {
            Ok(worker_results) => {
                for r in worker_results {
                    total_size += r.size;
                    // Store file info for the collection
                    collection_files.push(CollectionFileItem {
                        id: Uuid::new_v4().to_string(),
                        filename: r.filename.clone(),
                        url: r.url.clone(),
                        size: r.size,
                    });
                    results.push(r);
                }
            }
            Err(e) => eprintln!("Worker task failed: {}", e),
        }
    }

    // Mark collection as ready
    let final_collection = mark_collection_ready((*collection_id).clone()).await?;

    // Add collection to history with individual files
    let file_count = results.len() as u32;

    // Parse expires_at from API response
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

    // Return the collection as the first result
    let collection_result = UploadResult {
        url: final_collection.url,
        filename: format!("{} files", file_count),
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

    // Generate file_ids and send queued status for all files first
    let mut file_infos: Vec<(String, String)> = Vec::new(); // (path, file_id)

    for file_path in &files {
        let p = Path::new(file_path);
        let filename = p.file_name().and_then(|n| n.to_str()).unwrap_or("unknown").to_string();
        let size = fs::metadata(file_path).map(|m| m.len()).unwrap_or(0);
        let file_id = Uuid::new_v4().to_string();

        let _ = on_progress.send(UploadProgress {
            file_id: file_id.clone(),
            filename,
            bytes_uploaded: 0,
            total_bytes: size,
            percentage: 0.0,
            status: "queued".to_string(),
        });

        file_infos.push((file_path.clone(), file_id));
    }

    let collection = create_collection(Some(files.len())).await?;
    let collection_id = Arc::new(collection.id.clone());
    let on_progress = Arc::new(on_progress);

    // Use a channel-based work queue (pull-based like web app)
    let (tx, rx) = tokio::sync::mpsc::channel::<(String, String)>(file_infos.len());
    let rx = Arc::new(tokio::sync::Mutex::new(rx));

    // Send all work items to the queue
    for item in file_infos {
        let _ = tx.send(item).await;
    }
    drop(tx); // Close sender so workers know when done

    // Spawn worker tasks
    let mut handles = Vec::new();
    for _ in 0..CONCURRENT_UPLOADS {
        let rx = rx.clone();
        let coll_id = collection_id.clone();
        let progress = on_progress.clone();

        handles.push(tokio::spawn(async move {
            let mut results: Vec<UploadResult> = Vec::new();
            loop {
                let item = {
                    let mut rx = rx.lock().await;
                    rx.recv().await
                };
                match item {
                    Some((path, file_id)) => {
                        match upload_file(path, Some((*coll_id).clone()), (*progress).clone(), Some(file_id)).await {
                            Ok(r) => results.push(r),
                            Err(e) => eprintln!("Failed to upload file: {}", e),
                        }
                    }
                    None => break, // Channel closed, no more work
                }
            }
            results
        }));
    }

    // Collect results from all workers
    let mut total_size: u64 = 0;
    let mut success_count: u32 = 0;
    let mut collection_files: Vec<CollectionFileItem> = Vec::new();

    for handle in handles {
        match handle.await {
            Ok(worker_results) => {
                for r in worker_results {
                    total_size += r.size;
                    success_count += 1;
                    // Store file info for the collection
                    collection_files.push(CollectionFileItem {
                        id: Uuid::new_v4().to_string(),
                        filename: r.filename.clone(),
                        url: r.url.clone(),
                        size: r.size,
                    });
                }
            }
            Err(e) => eprintln!("Worker task failed: {}", e),
        }
    }

    let final_collection = mark_collection_ready((*collection_id).clone()).await?;

    // Parse expires_at from API response
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
        .plugin(tauri_plugin_screenshots::init());

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
            let _tray = TrayIconBuilder::new()
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
