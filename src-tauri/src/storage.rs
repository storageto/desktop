use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

const MAX_HISTORY_ITEMS: usize = 50;
const CONFIG_FILE: &str = "storageto.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CollectionFileItem {
    pub id: String,
    pub filename: String,
    pub url: String,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UploadHistoryItem {
    pub id: String,
    pub filename: String,
    pub url: String,
    pub size: u64,
    pub uploaded_at: DateTime<Utc>,
    pub is_collection: bool,
    pub file_count: Option<u32>,
    #[serde(default)]
    pub files: Option<Vec<CollectionFileItem>>,
    #[serde(default)]
    pub password_protected: Option<bool>,
    #[serde(default)]
    pub burn_after_reading: Option<bool>,
    #[serde(default)]
    pub expires_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AppConfig {
    pub visitor_token: Option<String>,
    pub api_url: String,
    pub upload_history: Vec<UploadHistoryItem>,
    pub auto_copy_url: bool,
    pub show_notifications: bool,
    #[serde(default)]
    pub has_launched: bool,
}

impl AppConfig {
    pub fn new() -> Self {
        Self {
            visitor_token: None,
            api_url: "https://storage.to".to_string(),
            upload_history: Vec::new(),
            auto_copy_url: true,
            show_notifications: true,
            has_launched: false,
        }
    }
}

fn get_config_dir() -> Option<PathBuf> {
    dirs::config_dir().map(|p| p.join("storageto"))
}

fn get_config_path() -> Option<PathBuf> {
    get_config_dir().map(|p| p.join(CONFIG_FILE))
}

pub fn load_config() -> AppConfig {
    let path = match get_config_path() {
        Some(p) => p,
        None => return AppConfig::new(),
    };

    if !path.exists() {
        return AppConfig::new();
    }

    match fs::read_to_string(&path) {
        Ok(content) => serde_json::from_str(&content).unwrap_or_else(|_| AppConfig::new()),
        Err(_) => AppConfig::new(),
    }
}

pub fn save_config(config: &AppConfig) -> Result<(), String> {
    let dir = get_config_dir().ok_or("Could not determine config directory")?;
    let path = get_config_path().ok_or("Could not determine config path")?;

    // Ensure directory exists
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create config directory: {}", e))?;

    let content =
        serde_json::to_string_pretty(config).map_err(|e| format!("Failed to serialize config: {}", e))?;

    fs::write(&path, content).map_err(|e| format!("Failed to write config: {}", e))?;

    Ok(())
}

pub fn add_to_history(item: UploadHistoryItem) -> Result<(), String> {
    let mut config = load_config();

    // Add new item at the beginning
    config.upload_history.insert(0, item);

    // Trim history to max size
    config.upload_history.truncate(MAX_HISTORY_ITEMS);

    save_config(&config)
}

pub fn get_history() -> Vec<UploadHistoryItem> {
    load_config().upload_history
}

pub fn clear_history() -> Result<(), String> {
    let mut config = load_config();
    config.upload_history.clear();
    save_config(&config)
}

pub fn remove_from_history(url: &str) -> Result<(), String> {
    let mut config = load_config();
    config.upload_history.retain(|item| item.url != url);
    save_config(&config)
}

pub fn get_visitor_token() -> Option<String> {
    let config = load_config();

    // If we have a valid UUID token, return it
    if let Some(ref token) = config.visitor_token {
        // Valid UUIDs are 36 chars with hyphens (e.g., 550e8400-e29b-41d4-a716-446655440000)
        if token.len() == 36 && token.contains('-') {
            return config.visitor_token;
        }
    }

    // Generate a new UUID token (same format as web app)
    let token = uuid::Uuid::new_v4().to_string();

    // Save it for future use
    let mut new_config = config;
    new_config.visitor_token = Some(token.clone());
    let _ = save_config(&new_config);

    Some(token)
}

pub fn set_visitor_token(token: String) -> Result<(), String> {
    let mut config = load_config();
    config.visitor_token = Some(token);
    save_config(&config)
}

pub fn get_api_url() -> String {
    load_config().api_url
}

pub fn set_api_url(url: String) -> Result<(), String> {
    let mut config = load_config();
    config.api_url = url;
    save_config(&config)
}

pub fn check_first_launch() -> bool {
    let config = load_config();
    if !config.has_launched {
        // Mark as launched for next time
        let mut new_config = config;
        new_config.has_launched = true;
        let _ = save_config(&new_config);
        return true;
    }
    false
}

pub fn update_history_item_protection(
    url: &str,
    password_protected: Option<bool>,
    burn_after_reading: Option<bool>,
    expires_at: Option<DateTime<Utc>>,
) -> Result<(), String> {
    let mut config = load_config();

    for item in &mut config.upload_history {
        if item.url == url {
            if let Some(pp) = password_protected {
                item.password_protected = Some(pp);
            }
            if let Some(bar) = burn_after_reading {
                item.burn_after_reading = Some(bar);
            }
            if let Some(exp) = expires_at {
                item.expires_at = Some(exp);
            }
            break;
        }
    }

    save_config(&config)
}
