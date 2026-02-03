use crate::storage::{add_to_history, get_api_url, get_visitor_token, set_visitor_token, UploadHistoryItem};
use chrono::Utc;
use reqwest::header::{HeaderMap, HeaderValue, CONTENT_LENGTH, CONTENT_TYPE};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::Read;
use std::path::Path;
use tauri::ipc::Channel;
use uuid::Uuid;

const MULTIPART_THRESHOLD: u64 = 50 * 1024 * 1024; // 50MB
const CHUNK_SIZE: u64 = 50 * 1024 * 1024; // 50MB chunks

#[derive(Debug, Clone, Serialize)]
pub struct UploadProgress {
    pub file_id: String,
    pub filename: String,
    pub bytes_uploaded: u64,
    pub total_bytes: u64,
    pub percentage: f64,
    pub status: String,
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
}

#[derive(Debug, Serialize)]
struct CompleteMultipartRequest {
    upload_id: String,
    parts: Vec<CompletedPart>,
}

#[derive(Debug, Serialize)]
struct CompletedPart {
    part_number: u32,
    etag: String,
}

use std::sync::OnceLock;

static HTTP_CLIENT: OnceLock<Client> = OnceLock::new();

fn get_client() -> &'static Client {
    HTTP_CLIENT.get_or_init(|| {
        Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .connect_timeout(std::time::Duration::from_secs(10))
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

    headers
}

fn get_content_type(path: &Path) -> String {
    mime_guess::from_path(path)
        .first_or_octet_stream()
        .to_string()
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
    });

    let client = get_client();
    let api_url = get_api_url();

    eprintln!("[Upload] Starting upload for: {} (size: {} bytes)", filename, size);
    eprintln!("[Upload] API URL: {}", api_url);

    // Step 1: Initialize upload
    let init_request = InitUploadRequest {
        filename: filename.clone(),
        size,
        content_type: content_type.clone(),
        collection_id: collection_id.clone(),
    };

    eprintln!("[Upload] Sending init request to {}/api/upload/init", api_url);

    let init_response = client
        .post(format!("{}/api/upload/init", api_url))
        .headers(get_headers())
        .json(&init_request)
        .send()
        .await
        .map_err(|e| {
            eprintln!("[Upload] Init request failed: {}", e);
            format!("Failed to initialize upload: {}", e)
        })?;

    eprintln!("[Upload] Init response status: {}", init_response.status());

    if !init_response.status().is_success() {
        let error_text = init_response.text().await.unwrap_or_default();
        eprintln!("[Upload] Init failed with error: {}", error_text);
        return Err(format!("Upload init failed: {}", error_text));
    }

    let response_text = init_response.text().await.map_err(|e| format!("Failed to read response: {}", e))?;
    eprintln!("[Upload] Init response body: {}", response_text);

    let init_data: InitUploadResponse = serde_json::from_str(&response_text)
        .map_err(|e| {
            eprintln!("[Upload] Failed to parse init response: {}", e);
            format!("Failed to parse init response: {}", e)
        })?;

    eprintln!("[Upload] Init response - success: {}, type: {:?}, r2_key: {:?}",
        init_data.success, init_data.upload_type, init_data.r2_key);

    if !init_data.success {
        let error = init_data.error.unwrap_or_else(|| "Unknown error".to_string());
        eprintln!("[Upload] Init failed: {}", error);
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
    });

    if upload_type == "multipart" {
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
        )
        .await?;
    } else {
        // Single upload
        let upload_url = init_data.upload_url.ok_or("No upload_url in response")?;
        upload_single(&client, &upload_url, path, size, &file_id, &filename, &on_progress).await?;
    }

    // Step 3: Confirm upload
    let _ = on_progress.send(UploadProgress {
        file_id: file_id.clone(),
        filename: filename.clone(),
        bytes_uploaded: size,
        total_bytes: size,
        percentage: 100.0,
        status: "confirming".to_string(),
    });

    let confirm_request = ConfirmUploadRequest {
        r2_key: r2_key.clone(),
        filename: filename.clone(),
        size,
        content_type,
        collection_id: collection_id.clone(),
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
) -> Result<(), String> {
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

    let response = client
        .put(upload_url)
        .header(CONTENT_TYPE, content_type)
        .header(CONTENT_LENGTH, size)
        .body(body)
        .send()
        .await
        .map_err(|e| format!("Failed to upload file: {}", e))?;

    if !response.status().is_success() {
        let error_text = response.text().await.unwrap_or_default();
        return Err(format!("Upload failed: {}", error_text));
    }

    Ok(())
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
) -> Result<(), String> {
    let mut file = File::open(path).map_err(|e| format!("Failed to open file: {}", e))?;
    let mut completed_parts: Vec<CompletedPart> = Vec::new();
    let mut bytes_uploaded: u64 = 0;
    let mut part_number: u32 = 1;
    let mut part_urls = initial_urls;

    loop {
        let mut buffer = vec![0u8; CHUNK_SIZE as usize];
        let bytes_read = file
            .read(&mut buffer)
            .map_err(|e| format!("Failed to read file chunk: {}", e))?;

        if bytes_read == 0 {
            break;
        }

        buffer.truncate(bytes_read);

        // Get the URL for this part
        let part_key = part_number.to_string();
        let part_url = match part_urls.get(&part_key) {
            Some(url) => url.clone(),
            None => {
                // Get more part URLs if needed
                let more_urls = get_more_parts_v2(client, api_url, upload_id, part_number).await?;
                part_urls.extend(more_urls);
                part_urls.get(&part_key)
                    .ok_or_else(|| format!("Missing URL for part {}", part_number))?
                    .clone()
            }
        };

        // Upload part
        let response = client
            .put(&part_url)
            .header(CONTENT_LENGTH, bytes_read)
            .body(buffer)
            .send()
            .await
            .map_err(|e| format!("Failed to upload part {}: {}", part_number, e))?;

        if !response.status().is_success() {
            return Err(format!("Part {} upload failed", part_number));
        }

        // Get ETag from response
        let etag = response
            .headers()
            .get("etag")
            .and_then(|v| v.to_str().ok())
            .map(|s| s.trim_matches('"').to_string())
            .ok_or_else(|| format!("Missing ETag for part {}", part_number))?;

        completed_parts.push(CompletedPart {
            part_number,
            etag,
        });

        bytes_uploaded += bytes_read as u64;
        let percentage = (bytes_uploaded as f64 / total_size as f64) * 100.0;

        let _ = on_progress.send(UploadProgress {
            file_id: file_id.to_string(),
            filename: filename.to_string(),
            bytes_uploaded,
            total_bytes: total_size,
            percentage,
            status: "uploading".to_string(),
        });

        part_number += 1;
    }

    // Complete multipart upload
    let complete_request = CompleteMultipartRequest {
        upload_id: upload_id.to_string(),
        parts: completed_parts,
    };

    let complete_response = client
        .post(format!("{}/api/upload/complete-multipart", api_url))
        .headers(get_headers())
        .json(&complete_request)
        .send()
        .await
        .map_err(|e| format!("Failed to complete multipart upload: {}", e))?;

    if !complete_response.status().is_success() {
        let error_text = complete_response.text().await.unwrap_or_default();
        return Err(format!("Complete multipart failed: {}", error_text));
    }

    Ok(())
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

pub async fn mark_collection_ready(collection_id: String) -> Result<CollectionInfo, String> {
    let client = get_client();
    let api_url = get_api_url();

    let response = client
        .post(format!("{}/api/collection/{}/ready", api_url, collection_id))
        .headers(get_headers())
        .send()
        .await
        .map_err(|e| format!("Failed to mark collection ready: {}", e))?;

    if !response.status().is_success() {
        let error_text = response.text().await.unwrap_or_default();
        return Err(format!("Mark collection ready failed: {}", error_text));
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

    if !response.status().is_success() {
        let status = response.status();
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
