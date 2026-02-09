use crate::storage::{add_to_history, get_api_url, get_auth_token, get_visitor_token, UploadHistoryItem};
use chrono::Utc;
use reqwest::header::{HeaderMap, HeaderValue, CONTENT_LENGTH, CONTENT_TYPE};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::error::Error;
use std::fs::File;
use std::io::{Read, Write};
use std::path::Path;
use tauri::ipc::Channel;
use uuid::Uuid;

const CHUNK_SIZE: u64 = 32 * 1024 * 1024; // 32MB chunks (matches API PART_SIZE)
const BATCH_SIZE: usize = 250; // Max files per batch API call

// Debug logging to file
fn debug_log(msg: &str) {
    let log_path = "/tmp/storageto_upload.log";
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path)
    {
        let timestamp = chrono::Local::now().format("%H:%M:%S%.3f");
        let _ = writeln!(file, "[{}] {}", timestamp, msg);
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct UploadProgress {
    pub file_id: String,
    pub filename: String,
    pub bytes_uploaded: u64,
    pub total_bytes: u64,
    pub percentage: f64,
    pub status: String,
    pub collection_id: Option<String>,
    pub collection_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UploadResult {
    pub url: String,
    pub filename: String,
    pub size: u64,
    pub is_collection: bool,
    pub file_count: Option<u32>,
}

#[derive(Debug, Deserialize)]
struct InitUploadResponse {
    success: bool,
    #[serde(rename = "type")]
    upload_type: Option<String>,
    upload_url: Option<String>,
    r2_key: Option<String>,
    #[serde(default)]
    headers: Option<std::collections::HashMap<String, Vec<String>>>,
    // Multipart fields
    upload_id: Option<String>,
    part_size: Option<i64>,
    total_parts: Option<i32>,
    initial_urls: Option<std::collections::HashMap<String, String>>,
    // Error fields
    error: Option<String>,
}


#[derive(Debug, Deserialize)]
struct ConfirmResponse {
    success: bool,
    file: Option<FileResponse>,
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct FileResponse {
    id: String,
    url: String,
    filename: String,
    size: u64,
    expires_at: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CollectionResponse {
    pub success: bool,
    pub error: Option<String>,
    pub collection: Option<CollectionInfo>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct CollectionInfo {
    pub id: String,
    pub url: String,
    pub expires_at: Option<String>,
}

#[derive(Debug, Serialize)]
struct InitUploadRequest {
    filename: String,
    size: u64,
    content_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    collection_id: Option<String>,
}

#[derive(Debug, Serialize)]
struct ConfirmUploadRequest {
    r2_key: String,
    filename: String,
    size: u64,
    content_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    collection_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    crc32: Option<u64>,
}

// Batch upload structs
#[derive(Debug, Clone, Serialize)]
pub struct BatchFileRequest {
    pub filename: String,
    pub content_type: String,
    pub size: u64,
}

#[derive(Debug, Serialize)]
struct InitBatchRequest {
    files: Vec<BatchFileRequest>,
}

#[derive(Debug, Deserialize)]
struct InitBatchResponse {
    success: bool,
    results: Option<std::collections::HashMap<String, InitBatchResult>>,
    error: Option<String>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct InitBatchResult {
    pub upload_url: Option<String>,
    pub r2_key: Option<String>,
    #[serde(rename = "type")]
    pub upload_type: Option<String>,
    // Multipart fields (for large files)
    pub upload_id: Option<String>,
    pub initial_urls: Option<std::collections::HashMap<String, String>>,
    // Error handling
    pub success: Option<bool>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct BatchConfirmFile {
    pub filename: String,
    pub size: u64,
    pub content_type: String,
    pub r2_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub crc32: Option<u64>,
}

#[derive(Debug, Serialize)]
struct ConfirmBatchRequest {
    collection_id: Option<String>,
    files: Vec<BatchConfirmFile>,
}

#[derive(Debug, Deserialize)]
struct ConfirmBatchResponse {
    success: bool,
    results: Option<std::collections::HashMap<String, ConfirmBatchResult>>,
    error: Option<String>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct ConfirmBatchResult {
    pub success: bool,
    pub file: Option<BatchConfirmedFile>,
    pub error: Option<String>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct BatchConfirmedFile {
    pub id: String,
    pub url: String,
}

#[derive(Debug, Serialize)]
struct CompleteMultipartRequest {
    upload_id: String,
    parts: Vec<CompletedPart>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CompletedPart {
    part_number: u32,
    etag: String,
}

use std::sync::OnceLock;

static HTTP_CLIENT: OnceLock<Client> = OnceLock::new();

fn get_client() -> &'static Client {
    HTTP_CLIENT.get_or_init(|| {
        Client::builder()
            // No overall timeout - uploads can take a long time
            // Only set connect timeout
            .connect_timeout(std::time::Duration::from_secs(30))
            .build()
            .unwrap_or_else(|_| Client::new())
    })
}

fn get_headers() -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert("Accept", HeaderValue::from_static("application/json"));

    if let Some(token) = get_visitor_token() {
        if let Ok(value) = HeaderValue::from_str(&token) {
            headers.insert("X-Visitor-Token", value);
        }
    }

    if let Some(auth_token) = get_auth_token() {
        if let Ok(value) = HeaderValue::from_str(&format!("Bearer {}", auth_token)) {
            headers.insert("Authorization", value);
        }
    }

    headers
}

fn get_content_type(path: &Path) -> String {
    mime_guess::from_path(path)
        .first_or_octet_stream()
        .to_string()
}

/// Initialize multiple uploads in a single API call (max 250 files per batch)
pub async fn init_batch(files: Vec<BatchFileRequest>) -> Result<std::collections::HashMap<String, InitBatchResult>, String> {
    let client = get_client();
    let api_url = get_api_url();

    debug_log(&format!("[Batch] Initializing {} files via init-batch", files.len()));
    debug_log(&format!("[Batch] API URL: {}/api/upload/init-batch", api_url));

    let request = InitBatchRequest { files };

    let response = client
        .post(format!("{}/api/upload/init-batch", api_url))
        .headers(get_headers())
        .json(&request)
        .send()
        .await
        .map_err(|e| format!("Failed to init batch: {}", e))?;

    debug_log(&format!("[Batch] Init response status: {}", response.status()));

    if !response.status().is_success() {
        let error_text = response.text().await.unwrap_or_default();
        debug_log(&format!("[Batch] Init batch failed: {}", error_text));
        return Err(format!("Init batch failed: {}", error_text));
    }

    let response_text = response.text().await.map_err(|e| format!("Failed to read response: {}", e))?;
    debug_log(&format!("[Batch] Init response (first 500 chars): {}", &response_text[..response_text.len().min(500)]));

    let data: InitBatchResponse = serde_json::from_str(&response_text)
        .map_err(|e| format!("Failed to parse init-batch response: {}", e))?;

    if !data.success {
        return Err(data.error.unwrap_or_else(|| "Unknown error".to_string()));
    }

    let results = data.results.ok_or_else(|| "No results in init-batch response".to_string())?;

    // Debug: log first result
    if let Some((key, result)) = results.iter().next() {
        debug_log(&format!("[Batch] First result key={}, upload_url={:?}, r2_key={:?}",
            key,
            result.upload_url.as_ref().map(|u| &u[..u.len().min(100)]),
            result.r2_key));
    }

    Ok(results)
}

/// Confirm multiple uploads in a single API call (max 250 files per batch)
/// Retries up to 3 times with exponential backoff on network/server errors.
pub async fn confirm_batch(
    collection_id: Option<String>,
    files: Vec<BatchConfirmFile>,
) -> Result<std::collections::HashMap<String, ConfirmBatchResult>, String> {
    let client = get_client();
    let api_url = get_api_url();

    debug_log(&format!("[Batch] Confirming {} files via confirm-batch", files.len()));

    let request = ConfirmBatchRequest {
        collection_id,
        files,
    };

    let mut last_error = String::new();
    for attempt in 0u32..3 {
        if attempt > 0 {
            debug_log(&format!("[Batch] Retrying confirm-batch (attempt {})", attempt + 1));
            tokio::time::sleep(std::time::Duration::from_secs(1 << attempt)).await;
        }

        let response = match client
            .post(format!("{}/api/upload/confirm-batch", api_url))
            .headers(get_headers())
            .json(&request)
            .send()
            .await
        {
            Ok(resp) => resp,
            Err(e) => {
                last_error = format!("Failed to confirm batch: {}", e);
                debug_log(&format!("[Batch] {}", last_error));
                continue;
            }
        };

        if !response.status().is_success() {
            let error_text = response.text().await.unwrap_or_default();
            last_error = format!("Confirm batch failed: {}", error_text);
            debug_log(&format!("[Batch] {}", last_error));
            continue;
        }

        let data: ConfirmBatchResponse = response
            .json()
            .await
            .map_err(|e| format!("Failed to parse confirm-batch response: {}", e))?;

        if !data.success {
            return Err(data.error.unwrap_or_else(|| "Unknown error".to_string()));
        }

        return data.results.ok_or_else(|| "No results in confirm-batch response".to_string());
    }

    Err(last_error)
}

/// Upload a single file directly to R2 using a presigned URL (no API calls, just R2)
pub async fn upload_to_r2(
    path: &Path,
    upload_url: &str,
    file_id: &str,
    filename: &str,
    size: u64,
    on_progress: &Channel<UploadProgress>,
    collection_id: Option<String>,
    collection_name: Option<String>,
) -> Result<u32, String> {
    upload_single(get_client(), upload_url, path, size, file_id, filename, on_progress, collection_id, collection_name).await
}

/// Upload a large file to R2 using multipart upload (no init/confirm API calls, just R2 parts + complete)
pub async fn upload_multipart_to_r2(
    path: &Path,
    upload_id: &str,
    r2_key: &str,
    size: u64,
    initial_urls: std::collections::HashMap<String, String>,
    file_id: &str,
    filename: &str,
    on_progress: &Channel<UploadProgress>,
    collection_id: Option<String>,
    collection_name: Option<String>,
) -> Result<u32, String> {
    upload_multipart_v2(
        get_client(),
        &get_api_url(),
        path,
        upload_id,
        r2_key,
        size,
        initial_urls,
        file_id,
        filename,
        on_progress,
        collection_id,
        collection_name,
    )
    .await
}

/// Get the BATCH_SIZE constant for external use
pub fn get_batch_size() -> usize {
    BATCH_SIZE
}

fn calculate_checksum(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|e| format!("Failed to open file: {}", e))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 8192];

    loop {
        let bytes_read = file.read(&mut buffer).map_err(|e| format!("Failed to read file: {}", e))?;
        if bytes_read == 0 {
            break;
        }
        hasher.update(&buffer[..bytes_read]);
    }

    Ok(hex::encode(hasher.finalize()))
}

fn compute_crc32(path: &Path) -> Result<u32, String> {
    let mut file = File::open(path).map_err(|e| format!("Failed to open file for CRC: {}", e))?;
    let mut hasher = crc32fast::Hasher::new();
    let mut buffer = [0u8; 65536];
    loop {
        let n = file.read(&mut buffer).map_err(|e| format!("CRC read error: {}", e))?;
        if n == 0 { break; }
        hasher.update(&buffer[..n]);
    }
    Ok(hasher.finalize())
}

pub async fn upload_file(
    path: String,
    collection_id: Option<String>,
    on_progress: Channel<UploadProgress>,
    existing_file_id: Option<String>,
) -> Result<UploadResult, String> {
    let path = Path::new(&path);
    let filename = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("Invalid filename")?
        .to_string();

    let metadata = std::fs::metadata(path).map_err(|e| format!("Failed to read file metadata: {}", e))?;
    let size = metadata.len();
    let content_type = get_content_type(path);
    let file_id = existing_file_id.unwrap_or_else(|| Uuid::new_v4().to_string());

    // Send initial progress
    let _ = on_progress.send(UploadProgress {
        file_id: file_id.clone(),
        filename: filename.clone(),
        bytes_uploaded: 0,
        total_bytes: size,
        percentage: 0.0,
        status: "initializing".to_string(),
        collection_id: None,
        collection_name: None,
    });

    let client = get_client();
    let api_url = get_api_url();

    debug_log(&format!("[Upload] Starting upload for: {} (size: {} bytes)", filename, size));
    debug_log(&format!("[Upload] API URL: {}", api_url));

    // Step 1: Initialize upload
    let init_request = InitUploadRequest {
        filename: filename.clone(),
        size,
        content_type: content_type.clone(),
        collection_id: collection_id.clone(),
    };

    debug_log(&format!("[Upload] Sending init request to {}/api/upload/init", api_url));

    let init_response = client
        .post(format!("{}/api/upload/init", api_url))
        .headers(get_headers())
        .json(&init_request)
        .send()
        .await
        .map_err(|e| {
            debug_log(&format!("[Upload] Init request failed: {}", e));
            format!("Failed to initialize upload: {}", e)
        })?;

    debug_log(&format!("[Upload] Init response status: {}", init_response.status()));

    if !init_response.status().is_success() {
        let error_text = init_response.text().await.unwrap_or_default();
        debug_log(&format!("[Upload] Init failed with error: {}", error_text));
        return Err(format!("Upload init failed: {}", error_text));
    }

    let response_text = init_response.text().await.map_err(|e| format!("Failed to read response: {}", e))?;
    debug_log(&format!("[Upload] Init response body: {}", response_text));

    let init_data: InitUploadResponse = serde_json::from_str(&response_text)
        .map_err(|e| {
            debug_log(&format!("[Upload] Failed to parse init response: {}", e));
            format!("Failed to parse init response: {}", e)
        })?;

    debug_log(&format!("[Upload] Init response - success: {}, type: {:?}, r2_key: {:?}",
        init_data.success, init_data.upload_type, init_data.r2_key));

    if !init_data.success {
        let error = init_data.error.unwrap_or_else(|| "Unknown error".to_string());
        debug_log(&format!("[Upload] Init failed: {}", error));
        return Err(format!("Upload init failed: {}", error));
    }

    let r2_key = init_data.r2_key.ok_or("No r2_key in response")?;
    let upload_type = init_data.upload_type.unwrap_or_else(|| "single".to_string());

    // Step 2: Upload file content
    let _ = on_progress.send(UploadProgress {
        file_id: file_id.clone(),
        filename: filename.clone(),
        bytes_uploaded: 0,
        total_bytes: size,
        percentage: 0.0,
        status: "uploading".to_string(),
        collection_id: None,
        collection_name: None,
    });

    let file_crc = if upload_type == "multipart" {
        // Multipart upload for large files
        let upload_id = init_data.upload_id.ok_or("No upload_id for multipart upload")?;
        let initial_urls = init_data.initial_urls.unwrap_or_default();

        upload_multipart_v2(
            &client,
            &api_url,
            path,
            &upload_id,
            &r2_key,
            size,
            initial_urls,
            &file_id,
            &filename,
            &on_progress,
            None,
            None,
        )
        .await?
    } else {
        // Single upload
        let upload_url = init_data.upload_url.ok_or("No upload_url in response")?;
        upload_single(&client, &upload_url, path, size, &file_id, &filename, &on_progress, None, None).await?
    };

    // Step 3: Confirm upload
    let _ = on_progress.send(UploadProgress {
        file_id: file_id.clone(),
        filename: filename.clone(),
        bytes_uploaded: size,
        total_bytes: size,
        percentage: 100.0,
        status: "confirming".to_string(),
        collection_id: None,
        collection_name: None,
    });

    let confirm_request = ConfirmUploadRequest {
        r2_key: r2_key.clone(),
        filename: filename.clone(),
        size,
        content_type,
        collection_id: collection_id.clone(),
        crc32: Some(file_crc as u64),
    };

    let confirm_response = client
        .post(format!("{}/api/upload/confirm", api_url))
        .headers(get_headers())
        .json(&confirm_request)
        .send()
        .await
        .map_err(|e| format!("Failed to confirm upload: {}", e))?;

    if !confirm_response.status().is_success() {
        let error_text = confirm_response.text().await.unwrap_or_default();
        return Err(format!("Upload confirmation failed: {}", error_text));
    }

    let confirm_data: ConfirmResponse = confirm_response
        .json()
        .await
        .map_err(|e| format!("Failed to parse confirm response: {}", e))?;

    if !confirm_data.success {
        let error = confirm_data.error.unwrap_or_else(|| "Unknown error".to_string());
        return Err(format!("Upload confirmation failed: {}", error));
    }

    let file_info = confirm_data.file.ok_or("No file in confirm response")?;

    // Add to history (only if not part of collection)
    if collection_id.is_none() {
        // Parse expires_at from API response
        let expires_at = file_info.expires_at.as_ref().and_then(|s| {
            chrono::DateTime::parse_from_rfc3339(s)
                .ok()
                .map(|dt| dt.with_timezone(&Utc))
        });

        let history_item = UploadHistoryItem {
            id: Uuid::new_v4().to_string(),
            filename: filename.clone(),
            url: file_info.url.clone(),
            size,
            uploaded_at: Utc::now(),
            is_collection: false,
            file_count: None,
            files: None,
            password_protected: None,
            burn_after_reading: None,
            expires_at,
        };
        let _ = add_to_history(history_item);
    }

    let _ = on_progress.send(UploadProgress {
        file_id: file_id.clone(),
        filename: filename.clone(),
        bytes_uploaded: size,
        total_bytes: size,
        percentage: 100.0,
        status: "complete".to_string(),
        collection_id: None,
        collection_name: None,
    });

    Ok(UploadResult {
        url: file_info.url,
        filename,
        size,
        is_collection: false,
        file_count: None,
    })
}

async fn upload_single(
    client: &Client,
    upload_url: &str,
    path: &Path,
    size: u64,
    file_id: &str,
    filename: &str,
    on_progress: &Channel<UploadProgress>,
    collection_id: Option<String>,
    collection_name: Option<String>,
) -> Result<u32, String> {
    use futures_util::stream::StreamExt;
    use tokio::io::AsyncReadExt;

    let content_type = get_content_type(path);

    // Open file for async reading
    let file = tokio::fs::File::open(path)
        .await
        .map_err(|e| format!("Failed to open file: {}", e))?;

    let file_id = file_id.to_string();
    let filename = filename.to_string();
    let progress = on_progress.clone();
    let coll_id = collection_id.clone();
    let coll_name = collection_name.clone();

    // Create a stream that reports progress as chunks are read
    let chunk_size = 256 * 1024; // 256KB chunks
    let mut reader = tokio::io::BufReader::with_capacity(chunk_size, file);
    let mut bytes_sent: u64 = 0;

    let stream = async_stream::stream! {
        let mut buffer = vec![0u8; chunk_size];
        loop {
            match reader.read(&mut buffer).await {
                Ok(0) => break, // EOF
                Ok(n) => {
                    bytes_sent += n as u64;
                    let percentage = (bytes_sent as f64 / size as f64) * 100.0;

                    let _ = progress.send(UploadProgress {
                        file_id: file_id.clone(),
                        filename: filename.clone(),
                        bytes_uploaded: bytes_sent,
                        total_bytes: size,
                        percentage,
                        status: "uploading".to_string(),
                        collection_id: coll_id.clone(),
                        collection_name: coll_name.clone(),
                    });

                    yield Ok::<_, std::io::Error>(bytes::Bytes::copy_from_slice(&buffer[..n]));
                }
                Err(e) => {
                    yield Err(e);
                    break;
                }
            }
        }
    };

    let body = reqwest::Body::wrap_stream(stream);

    debug_log(&format!("[R2] PUT request to: {}...", &upload_url[..upload_url.len().min(80)]));
    debug_log(&format!("[R2] Content-Type: {}, Content-Length: {}", content_type, size));

    let response = client
        .put(upload_url)
        .header(CONTENT_TYPE, content_type.clone())
        .header(CONTENT_LENGTH, size)
        .body(body)
        .send()
        .await
        .map_err(|e| {
            debug_log(&format!("[R2] PUT failed: {:?}", e));
            debug_log(&format!("[R2] Error kind: {:?}", e.status()));
            debug_log(&format!("[R2] Is connect: {}, Is timeout: {}, Is request: {}",
                e.is_connect(), e.is_timeout(), e.is_request()));
            if let Some(source) = e.source() {
                debug_log(&format!("[R2] Source error: {:?}", source));
            }
            format!("Failed to upload file: {}", e)
        })?;

    debug_log(&format!("[R2] PUT response status: {}", response.status()));

    if !response.status().is_success() {
        let error_text = response.text().await.unwrap_or_default();
        return Err(format!("Upload failed: {}", error_text));
    }

    compute_crc32(path)
}

async fn upload_multipart_v2(
    client: &Client,
    api_url: &str,
    path: &Path,
    upload_id: &str,
    _r2_key: &str,
    total_size: u64,
    initial_urls: std::collections::HashMap<String, String>,
    file_id: &str,
    filename: &str,
    on_progress: &Channel<UploadProgress>,
    collection_id: Option<String>,
    collection_name: Option<String>,
) -> Result<u32, String> {
    use std::sync::atomic::AtomicU64;
    use tokio::io::AsyncReadExt;

    const MAX_CONCURRENT: usize = 4;
    const MAX_RETRIES: u32 = 3;

    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(|e| format!("Failed to open file: {}", e))?;
    let mut completed_parts: Vec<CompletedPart> = Vec::new();
    let mut part_number: u32 = 1;
    let mut part_urls = initial_urls;

    // Shared atomic counter for smooth cross-task progress reporting
    let bytes_uploaded = std::sync::Arc::new(AtomicU64::new(0));

    loop {
        let mut batch: Vec<(u32, Vec<u8>, String)> = Vec::new();

        // Pre-read up to MAX_CONCURRENT parts from disk
        for _ in 0..MAX_CONCURRENT {
            let part_start = (part_number as u64 - 1) * CHUNK_SIZE;
            let part_size = std::cmp::min(CHUNK_SIZE, total_size.saturating_sub(part_start)) as usize;

            if part_size == 0 {
                break;
            }

            // Read this part into memory
            let mut buf = vec![0u8; part_size];
            file.read_exact(&mut buf)
                .await
                .map_err(|e| format!("Failed to read part {}: {}", part_number, e))?;

            // Get the URL for this part
            let part_key = part_number.to_string();
            let part_url = match part_urls.get(&part_key) {
                Some(url) => url.clone(),
                None => {
                    let more_urls = get_more_parts_v2(client, api_url, upload_id, part_number).await?;
                    part_urls.extend(more_urls);
                    part_urls.get(&part_key)
                        .ok_or_else(|| format!("Missing URL for part {}", part_number))?
                        .clone()
                }
            };

            batch.push((part_number, buf, part_url));
            part_number += 1;
        }

        if batch.is_empty() {
            break;
        }

        // Spawn concurrent upload tasks
        let mut join_set = tokio::task::JoinSet::new();
        for (pn, data, url) in batch {
            let task_client = client.clone();
            let progress = bytes_uploaded.clone();
            let channel = on_progress.clone();
            let task_file_id = file_id.to_string();
            let task_filename = filename.to_string();
            let task_coll_id = collection_id.clone();
            let task_coll_name = collection_name.clone();

            join_set.spawn(async move {
                upload_part_with_retry(
                    &task_client, &url, data, pn,
                    &progress, total_size,
                    &channel, &task_file_id, &task_filename,
                    MAX_RETRIES,
                    task_coll_id, task_coll_name,
                ).await
            });
        }

        // Collect results from this batch
        while let Some(result) = join_set.join_next().await {
            let part = result
                .map_err(|e| format!("Upload task panicked: {}", e))?
                .map_err(|e| format!("Upload failed: {}", e))?;
            completed_parts.push(part);
        }
    }

    // Sort parts by part_number before completing
    completed_parts.sort_by_key(|p| p.part_number);

    // Complete multipart upload (with retry)
    let complete_request = CompleteMultipartRequest {
        upload_id: upload_id.to_string(),
        parts: completed_parts,
    };

    let mut last_error = String::new();
    for attempt in 0u32..3 {
        if attempt > 0 {
            debug_log(&format!("[Multipart] Retrying complete-multipart (attempt {})", attempt + 1));
            tokio::time::sleep(std::time::Duration::from_secs(1 << attempt)).await;
        }

        let resp = match client
            .post(format!("{}/api/upload/complete-multipart", api_url))
            .headers(get_headers())
            .json(&complete_request)
            .send()
            .await
        {
            Ok(r) => r,
            Err(e) => {
                last_error = format!("Failed to complete multipart upload: {}", e);
                debug_log(&format!("[Multipart] {}", last_error));
                continue;
            }
        };

        if !resp.status().is_success() {
            let error_text = resp.text().await.unwrap_or_default();
            last_error = format!("Complete multipart failed: {}", error_text);
            debug_log(&format!("[Multipart] {}", last_error));
            continue;
        }

        return compute_crc32(path);
    }

    Err(last_error)
}

/// Upload a single part with retry (up to max_retries attempts, exponential backoff)
async fn upload_part_with_retry(
    client: &Client,
    url: &str,
    data: Vec<u8>,
    part_number: u32,
    bytes_uploaded: &std::sync::Arc<std::sync::atomic::AtomicU64>,
    total_size: u64,
    on_progress: &Channel<UploadProgress>,
    file_id: &str,
    filename: &str,
    max_retries: u32,
    collection_id: Option<String>,
    collection_name: Option<String>,
) -> Result<CompletedPart, String> {
    use std::sync::atomic::Ordering;

    let part_size = data.len();
    let stream_chunk_size = 256 * 1024usize;

    for attempt in 0..max_retries {
        // Stream the buffer in 256KB pieces for progress reporting
        let progress = bytes_uploaded.clone();
        let channel = on_progress.clone();
        let p_file_id = file_id.to_string();
        let p_filename = filename.to_string();
        let p_coll_id = collection_id.clone();
        let p_coll_name = collection_name.clone();
        let data_clone = data.clone();

        let stream = async_stream::stream! {
            let mut offset = 0usize;
            while offset < data_clone.len() {
                let end = std::cmp::min(offset + stream_chunk_size, data_clone.len());
                let chunk = &data_clone[offset..end];
                let chunk_len = chunk.len() as u64;

                let sent = progress.fetch_add(chunk_len, Ordering::Relaxed) + chunk_len;
                let pct = (sent as f64 / total_size as f64) * 100.0;

                let _ = channel.send(UploadProgress {
                    file_id: p_file_id.clone(),
                    filename: p_filename.clone(),
                    bytes_uploaded: sent,
                    total_bytes: total_size,
                    percentage: pct,
                    status: "uploading".to_string(),
                    collection_id: p_coll_id.clone(),
                    collection_name: p_coll_name.clone(),
                });

                yield Ok::<_, std::io::Error>(bytes::Bytes::copy_from_slice(chunk));
                offset = end;
            }
        };

        let body = reqwest::Body::wrap_stream(stream);

        match client
            .put(url)
            .header(CONTENT_LENGTH, part_size)
            .body(body)
            .send()
            .await
        {
            Ok(response) if response.status().is_success() => {
                let etag = response
                    .headers()
                    .get("etag")
                    .and_then(|v| v.to_str().ok())
                    .map(|s| s.trim_matches('"').to_string())
                    .ok_or_else(|| format!("Missing ETag for part {}", part_number))?;

                return Ok(CompletedPart { part_number, etag });
            }
            Ok(response) => {
                let status = response.status();
                debug_log(&format!(
                    "[Multipart] Part {} attempt {}/{} failed with status {}",
                    part_number, attempt + 1, max_retries, status
                ));
                // Roll back progress for retry
                bytes_uploaded.fetch_sub(part_size as u64, std::sync::atomic::Ordering::Relaxed);
                if attempt + 1 >= max_retries {
                    return Err(format!("Part {} upload failed with status {} after {} attempts", part_number, status, max_retries));
                }
                tokio::time::sleep(std::time::Duration::from_secs(1 << attempt)).await;
            }
            Err(e) => {
                debug_log(&format!(
                    "[Multipart] Part {} attempt {}/{} error: {}",
                    part_number, attempt + 1, max_retries, e
                ));
                // Roll back progress for retry
                bytes_uploaded.fetch_sub(part_size as u64, std::sync::atomic::Ordering::Relaxed);
                if attempt + 1 >= max_retries {
                    return Err(format!("Part {} upload failed after {} attempts: {}", part_number, max_retries, e));
                }
                tokio::time::sleep(std::time::Duration::from_secs(1 << attempt)).await;
            }
        }
    }

    Err(format!("Part {} upload failed after {} attempts", part_number, max_retries))
}

async fn get_more_parts_v2(
    client: &Client,
    api_url: &str,
    upload_id: &str,
    start_part: u32,
) -> Result<std::collections::HashMap<String, String>, String> {
    #[derive(Serialize)]
    struct GetPartsRequest {
        upload_id: String,
        start_part: u32,
        count: u32,
    }

    #[derive(Deserialize)]
    struct GetPartsResponse {
        part_urls: std::collections::HashMap<String, String>,
    }

    let request = GetPartsRequest {
        upload_id: upload_id.to_string(),
        start_part,
        count: 250,
    };

    let response = client
        .post(format!("{}/api/upload/parts", api_url))
        .headers(get_headers())
        .json(&request)
        .send()
        .await
        .map_err(|e| format!("Failed to get part URLs: {}", e))?;

    if !response.status().is_success() {
        return Err("Failed to get more part URLs".to_string());
    }

    let data: GetPartsResponse = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse parts response: {}", e))?;

    Ok(data.part_urls)
}

pub async fn create_collection(expected_file_count: Option<usize>) -> Result<CollectionInfo, String> {
    let client = get_client();
    let api_url = get_api_url();

    #[derive(Serialize)]
    struct CreateCollectionRequest {
        #[serde(skip_serializing_if = "Option::is_none")]
        expected_file_count: Option<usize>,
    }

    let response = client
        .post(format!("{}/api/collection", api_url))
        .headers(get_headers())
        .json(&CreateCollectionRequest { expected_file_count })
        .send()
        .await
        .map_err(|e| format!("Failed to create collection: {}", e))?;

    if !response.status().is_success() {
        let error_text = response.text().await.unwrap_or_default();
        return Err(format!("Create collection failed: {}", error_text));
    }

    let resp: CollectionResponse = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse collection response: {}", e))?;

    if !resp.success {
        return Err(resp.error.unwrap_or_else(|| "Unknown error".to_string()));
    }

    resp.collection.ok_or_else(|| "No collection in response".to_string())
}

/// Retries up to 3 times with exponential backoff on network/server errors.
pub async fn mark_collection_ready(collection_id: String) -> Result<CollectionInfo, String> {
    let client = get_client();
    let api_url = get_api_url();

    let mut last_error = String::new();
    for attempt in 0u32..3 {
        if attempt > 0 {
            debug_log(&format!("[Collection] Retrying mark_collection_ready (attempt {})", attempt + 1));
            tokio::time::sleep(std::time::Duration::from_secs(1 << attempt)).await;
        }

        let response = match client
            .post(format!("{}/api/collection/{}/ready", api_url, collection_id))
            .headers(get_headers())
            .send()
            .await
        {
            Ok(r) => r,
            Err(e) => {
                last_error = format!("Failed to mark collection ready: {}", e);
                debug_log(&format!("[Collection] {}", last_error));
                continue;
            }
        };

        if !response.status().is_success() {
            let error_text = response.text().await.unwrap_or_default();
            last_error = format!("Mark collection ready failed: {}", error_text);
            debug_log(&format!("[Collection] {}", last_error));
            continue;
        }

        let resp: CollectionResponse = response
            .json()
            .await
            .map_err(|e| format!("Failed to parse collection response: {}", e))?;

        if !resp.success {
            return Err(resp.error.unwrap_or_else(|| "Unknown error".to_string()));
        }

        return resp.collection.ok_or_else(|| "No collection in response".to_string());
    }

    Err(last_error)
}

pub async fn delete_file(file_id: String, is_collection: bool) -> Result<(), String> {
    let client = get_client();
    let api_url = get_api_url();

    // Use different endpoint for collections vs files
    let endpoint = if is_collection {
        format!("{}/api/collection/{}", api_url, file_id)
    } else {
        format!("{}/api/file/{}", api_url, file_id)
    };

    let response = client
        .delete(&endpoint)
        .headers(get_headers())
        .send()
        .await
        .map_err(|e| format!("Failed to delete: {}", e))?;

    let status = response.status();

    // Treat 404 as success - file is already gone, which is what we wanted
    if status.as_u16() == 404 {
        return Ok(());
    }

    if !status.is_success() {
        let error_text = response.text().await.unwrap_or_default();
        return Err(format!("Delete failed ({}): {}", status, error_text));
    }

    #[derive(Deserialize)]
    struct DeleteResponse {
        success: bool,
        error: Option<String>,
    }

    let resp: DeleteResponse = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse delete response: {}", e))?;

    if !resp.success {
        return Err(resp.error.unwrap_or_else(|| "Unknown error".to_string()));
    }

    Ok(())
}

pub async fn set_password(file_id: String, is_collection: bool, password: String) -> Result<(), String> {
    let client = get_client();
    let api_url = get_api_url();

    // API routes: /api/file/{id}/password or /api/collection/{id}/password
    let endpoint = if is_collection {
        format!("{}/api/collection/{}/password", api_url, file_id)
    } else {
        format!("{}/api/file/{}/password", api_url, file_id)
    };

    #[derive(Serialize)]
    struct PasswordRequest {
        password: String,
    }

    let response = client
        .post(&endpoint)
        .headers(get_headers())
        .json(&PasswordRequest { password })
        .send()
        .await
        .map_err(|e| format!("Failed to set password: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let error_text = response.text().await.unwrap_or_default();
        return Err(format!("Set password failed ({}): {}", status, error_text));
    }

    #[derive(Deserialize)]
    struct ApiResponse {
        success: bool,
        error: Option<String>,
    }

    let resp: ApiResponse = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {}", e))?;

    if !resp.success {
        return Err(resp.error.unwrap_or_else(|| "Unknown error".to_string()));
    }

    Ok(())
}

pub async fn set_expiry(file_id: String, is_collection: bool, days: u32) -> Result<(), String> {
    let client = get_client();
    let api_url = get_api_url();

    // API routes: /api/file/{id}/expiry or /api/collection/{id}/expiry
    let endpoint = if is_collection {
        format!("{}/api/collection/{}/expiry", api_url, file_id)
    } else {
        format!("{}/api/file/{}/expiry", api_url, file_id)
    };

    #[derive(Serialize)]
    struct ExpiryRequest {
        days: u32,
    }

    let response = client
        .post(&endpoint)
        .headers(get_headers())
        .json(&ExpiryRequest { days })
        .send()
        .await
        .map_err(|e| format!("Failed to set expiry: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let error_text = response.text().await.unwrap_or_default();
        return Err(format!("Set expiry failed ({}): {}", status, error_text));
    }

    #[derive(Deserialize)]
    struct ApiResponse {
        success: bool,
        error: Option<String>,
    }

    let resp: ApiResponse = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {}", e))?;

    if !resp.success {
        return Err(resp.error.unwrap_or_else(|| "Unknown error".to_string()));
    }

    Ok(())
}

pub async fn set_burn_after_reading(file_id: String, is_collection: bool) -> Result<(), String> {
    let client = get_client();
    let api_url = get_api_url();

    // API routes: /api/file/{id}/max-downloads or /api/collection/{id}/max-downloads
    let endpoint = if is_collection {
        format!("{}/api/collection/{}/max-downloads", api_url, file_id)
    } else {
        format!("{}/api/file/{}/max-downloads", api_url, file_id)
    };

    #[derive(Serialize)]
    struct MaxDownloadsRequest {
        max_downloads: u32,
    }

    // Burn after reading = max 1 download
    let response = client
        .post(&endpoint)
        .headers(get_headers())
        .json(&MaxDownloadsRequest { max_downloads: 1 })
        .send()
        .await
        .map_err(|e| format!("Failed to set burn after reading: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let error_text = response.text().await.unwrap_or_default();
        return Err(format!("Set burn after reading failed ({}): {}", status, error_text));
    }

    #[derive(Deserialize)]
    struct ApiResponse {
        success: bool,
        error: Option<String>,
    }

    let resp: ApiResponse = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {}", e))?;

    if !resp.success {
        return Err(resp.error.unwrap_or_else(|| "Unknown error".to_string()));
    }

    Ok(())
}

pub async fn remove_password(file_id: String, is_collection: bool) -> Result<(), String> {
    let client = get_client();
    let api_url = get_api_url();

    // API routes: DELETE /api/file/{id}/password or /api/collection/{id}/password
    let endpoint = if is_collection {
        format!("{}/api/collection/{}/password", api_url, file_id)
    } else {
        format!("{}/api/file/{}/password", api_url, file_id)
    };

    let response = client
        .delete(&endpoint)
        .headers(get_headers())
        .send()
        .await
        .map_err(|e| format!("Failed to remove password: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let error_text = response.text().await.unwrap_or_default();
        return Err(format!("Remove password failed ({}): {}", status, error_text));
    }

    #[derive(Deserialize)]
    struct ApiResponse {
        success: bool,
        error: Option<String>,
    }

    let resp: ApiResponse = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {}", e))?;

    if !resp.success {
        return Err(resp.error.unwrap_or_else(|| "Unknown error".to_string()));
    }

    Ok(())
}

pub async fn remove_burn_after_reading(file_id: String, is_collection: bool) -> Result<(), String> {
    let client = get_client();
    let api_url = get_api_url();

    // API routes: /api/file/{id}/max-downloads or /api/collection/{id}/max-downloads
    let endpoint = if is_collection {
        format!("{}/api/collection/{}/max-downloads", api_url, file_id)
    } else {
        format!("{}/api/file/{}/max-downloads", api_url, file_id)
    };

    // Remove burn after reading = set max_downloads to null
    let response = client
        .post(&endpoint)
        .headers(get_headers())
        .json(&serde_json::json!({ "max_downloads": null }))
        .send()
        .await
        .map_err(|e| format!("Failed to remove burn after reading: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let error_text = response.text().await.unwrap_or_default();
        return Err(format!("Remove burn after reading failed ({}): {}", status, error_text));
    }

    #[derive(Deserialize)]
    struct ApiResponse {
        success: bool,
        error: Option<String>,
    }

    let resp: ApiResponse = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {}", e))?;

    if !resp.success {
        return Err(resp.error.unwrap_or_else(|| "Unknown error".to_string()));
    }

    Ok(())
}
