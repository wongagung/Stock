#![forbid(unsafe_code)]

use hmac::{Hmac, Mac};
use rand::RngCore;
use reqwest::redirect::Policy;
use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use std::fs;
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::time::Duration;
use thiserror::Error;

type HmacSha256 = Hmac<Sha256>;

pub const DEFAULT_SPREADSHEET_ID: &str = "1CGDtZVFmCgDzUo9BfXFgUHKgP2yOG6PVE5GZdRKDSwk";

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SheetKind {
    PotonganKu,
    InvMtc,
    Invall,
}

impl SheetKind {
    pub fn gid(self) -> &'static str {
        match self {
            SheetKind::PotonganKu => "148790630",
            SheetKind::InvMtc => "1467647988",
            SheetKind::Invall => "1619403319",
        }
    }

    pub fn cache_key(self) -> &'static str {
        match self {
            SheetKind::PotonganKu => "potongan_ku",
            SheetKind::InvMtc => "inv_mtc",
            SheetKind::Invall => "invall",
        }
    }
}

pub fn compute_sha256_hex(text: &str) -> String {
    use sha2::Digest;
    let mut hasher = Sha256::new();
    hasher.update(text.as_bytes());
    hex::encode(hasher.finalize())
}
const MAX_RESPONSE_BYTES: usize = 10 * 1024 * 1024; // 10 MB hard cap
const REQUEST_TIMEOUT_SECS: u64 = 15;

#[derive(Debug, Error)]
pub enum SecurityError {
    #[error("URL ditolak oleh kebijakan keamanan: {0}")]
    InvalidUrl(String),
    #[error("Ukuran respons melebihi batas aman (10 MB)")]
    PayloadTooLarge,
    #[error("Gagal mengambil data TLS: {0}")]
    NetworkError(String),
    #[error("Integritas cache lokal gagal diverifikasi (HMAC mismatch)")]
    CacheIntegrityFailed,
    #[error("Kesalahan I/O aman: {0}")]
    IoError(String),
}

#[derive(Debug, Clone, Serialize)]
pub struct SecurityPosture {
    pub tls_enforced: String,
    pub csp_policy: String,
    pub ssrf_allowlist: Vec<String>,
    pub cache_integrity: String,
    pub unsafe_rust_forbidden: bool,
    pub csv_formula_protection: bool,
    pub max_payload_mb: usize,
}

pub fn current_security_posture() -> SecurityPosture {
    SecurityPosture {
        tls_enforced: "TLS 1.2+ (rustls pure-Rust)".to_string(),
        csp_policy: "Strict CSP (connect-src 'none', object-src 'none')".to_string(),
        ssrf_allowlist: vec![
            "docs.google.com".to_string(),
            "*.googleusercontent.com".to_string(),
        ],
        cache_integrity: "HMAC-SHA256 per-install OS-CSPRNG key".to_string(),
        unsafe_rust_forbidden: true,
        csv_formula_protection: true,
        max_payload_mb: MAX_RESPONSE_BYTES / (1024 * 1024),
    }
}

fn is_allowed_host(host: &str) -> bool {
    let lower = host.to_ascii_lowercase();
    lower == "docs.google.com"
        || lower == "googleusercontent.com"
        || lower.ends_with(".googleusercontent.com")
}

fn is_private_or_special_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_broadcast()
                || v4.is_documentation()
                || v4.is_unspecified()
        }
        IpAddr::V6(v6) => v6.is_loopback() || v6.is_unspecified(),
    }
}

pub fn build_canonical_sheet_url(spreadsheet_id: &str, gid: &str) -> Result<Url, SecurityError> {
    if spreadsheet_id.len() < 10
        || spreadsheet_id.len() > 128
        || !spreadsheet_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err(SecurityError::InvalidUrl(
            "Spreadsheet ID mengandung karakter tidak valid".to_string(),
        ));
    }

    if gid.is_empty() || gid.len() > 20 || !gid.chars().all(|c| c.is_ascii_digit()) {
        return Err(SecurityError::InvalidUrl(
            "GID harus berupa digit numerik".to_string(),
        ));
    }

    let raw = format!(
        "https://docs.google.com/spreadsheets/d/{}/export?format=csv&gid={}",
        spreadsheet_id, gid
    );
    let parsed = Url::parse(&raw).map_err(|e| SecurityError::InvalidUrl(e.to_string()))?;
    if parsed.scheme() != "https" {
        return Err(SecurityError::InvalidUrl("Hanya HTTPS yang diizinkan".to_string()));
    }
    Ok(parsed)
}

pub async fn fetch_verified_csv(spreadsheet_id: &str, gid: &str) -> Result<String, SecurityError> {
    let target_url = build_canonical_sheet_url(spreadsheet_id, gid)?;

    let redirect_policy = Policy::custom(|attempt| {
        if attempt.previous().len() >= 4 {
            return attempt.error("Terlalu banyak redirect");
        }
        let next = attempt.url();
        if next.scheme() != "https" {
            return attempt.error("Redirect ke non-HTTPS ditolak");
        }
        match next.host_str() {
            Some(host) => {
                if let Ok(ip) = host.parse::<IpAddr>() {
                    if is_private_or_special_ip(ip) {
                        return attempt.error("Redirect ke IP privat/loopback ditolak");
                    }
                }
                if is_allowed_host(host) {
                    attempt.follow()
                } else {
                    attempt.error("Redirect ke host di luar allowlist ditolak")
                }
            }
            None => attempt.error("Redirect tanpa host ditolak"),
        }
    });

    let client = Client::builder()
        .use_rustls_tls()
        .min_tls_version(reqwest::tls::Version::TLS_1_2)
        .https_only(true)
        .redirect(redirect_policy)
        .connect_timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
        .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
        .user_agent("StockMaterialDashboard/1.0 (Hardened-Rust)")
        .build()
        .map_err(|e| SecurityError::NetworkError(e.to_string()))?;

    let response = client
        .get(target_url)
        .send()
        .await
        .map_err(|e| SecurityError::NetworkError(e.to_string()))?;

    if !response.status().is_success() {
        return Err(SecurityError::NetworkError(format!(
            "HTTP status {}",
            response.status()
        )));
    }

    if let Some(len) = response.content_length() {
        if len as usize > MAX_RESPONSE_BYTES {
            return Err(SecurityError::PayloadTooLarge);
        }
    }

    let bytes = response
        .bytes()
        .await
        .map_err(|e| SecurityError::NetworkError(e.to_string()))?;

    if bytes.len() > MAX_RESPONSE_BYTES {
        return Err(SecurityError::PayloadTooLarge);
    }

    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// Strip ASCII control characters and bound string length.
pub fn sanitize_cell_text(input: &str, max_len: usize) -> String {
    let cleaned: String = input
        .chars()
        .filter(|c| !c.is_control() || *c == ' ')
        .collect();
    let trimmed = cleaned.trim();
    if trimmed.chars().count() > max_len {
        trimmed.chars().take(max_len).collect()
    } else {
        trimmed.to_string()
    }
}

/// OWASP CSV Injection mitigation: neutralize leading formula triggers (`=`, `+`, `-`, `@`, `\t`, `\r`).
pub fn escape_csv_cell(input: &str) -> String {
    let sanitized = sanitize_cell_text(input, 512);
    let neutralized = match sanitized.chars().next() {
        Some('=' | '+' | '-' | '@' | '\t' | '\r') => format!("'{}", sanitized),
        _ => sanitized,
    };
    if neutralized.contains(',') || neutralized.contains('"') || neutralized.contains('\n') {
        format!("\"{}\"", neutralized.replace('"', "\"\""))
    } else {
        neutralized
    }
}

#[derive(Debug, Serialize, Deserialize)]
struct CacheEnvelope {
    payload_json: String,
    hmac_hex: String,
    cached_at_unix: i64,
}

fn load_or_create_hmac_key(app_data_dir: &Path) -> Result<[u8; 32], SecurityError> {
    fs::create_dir_all(app_data_dir).map_err(|e| SecurityError::IoError(e.to_string()))?;
    let key_path = app_data_dir.join(".cache_hmac_key");
    if key_path.exists() {
        let raw = fs::read(&key_path).map_err(|e| SecurityError::IoError(e.to_string()))?;
        if raw.len() == 32 {
            let mut key = [0u8; 32];
            key.copy_from_slice(&raw);
            return Ok(key);
        }
    }
    let mut key = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut key);
    fs::write(&key_path, &key).map_err(|e| SecurityError::IoError(e.to_string()))?;
    Ok(key)
}

fn cache_file_path(app_data_dir: &Path, cache_key: &str) -> PathBuf {
    let safe_key: String = cache_key
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_')
        .collect();
    app_data_dir.join(format!("cache_{}.signed.json", safe_key))
}

pub fn save_signed_cache<T: Serialize>(
    app_data_dir: &Path,
    cache_key: &str,
    data: &T,
) -> Result<(), SecurityError> {
    let key = load_or_create_hmac_key(app_data_dir)?;
    let payload_json =
        serde_json::to_string(data).map_err(|e| SecurityError::IoError(e.to_string()))?;

    let mut mac =
        HmacSha256::new_from_slice(&key).map_err(|e| SecurityError::IoError(e.to_string()))?;
    mac.update(payload_json.as_bytes());
    let hmac_hex = hex::encode(mac.finalize().into_bytes());

    let envelope = CacheEnvelope {
        payload_json,
        hmac_hex,
        cached_at_unix: chrono::Utc::now().timestamp(),
    };
    let encoded =
        serde_json::to_string_pretty(&envelope).map_err(|e| SecurityError::IoError(e.to_string()))?;
    fs::write(cache_file_path(app_data_dir, cache_key), encoded)
        .map_err(|e| SecurityError::IoError(e.to_string()))?;
    Ok(())
}

pub fn load_verified_cache<T: for<'de> Deserialize<'de>>(
    app_data_dir: &Path,
    cache_key: &str,
) -> Result<Option<(T, i64)>, SecurityError> {
    let path = cache_file_path(app_data_dir, cache_key);
    if !path.exists() {
        return Ok(None);
    }
    let key = load_or_create_hmac_key(app_data_dir)?;
    let raw = fs::read_to_string(&path).map_err(|e| SecurityError::IoError(e.to_string()))?;
    let envelope: CacheEnvelope =
        serde_json::from_str(&raw).map_err(|_| SecurityError::CacheIntegrityFailed)?;

    let expected_bytes =
        hex::decode(&envelope.hmac_hex).map_err(|_| SecurityError::CacheIntegrityFailed)?;
    let mut mac =
        HmacSha256::new_from_slice(&key).map_err(|e| SecurityError::IoError(e.to_string()))?;
    mac.update(envelope.payload_json.as_bytes());
    mac.verify_slice(&expected_bytes)
        .map_err(|_| SecurityError::CacheIntegrityFailed)?;

    let data: T = serde_json::from_str(&envelope.payload_json)
        .map_err(|_| SecurityError::CacheIntegrityFailed)?;
    Ok(Some((data, envelope.cached_at_unix)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_canonical_url_validation() {
        let ok = build_canonical_sheet_url(DEFAULT_SPREADSHEET_ID, SheetKind::PotonganKu.gid());
        assert!(ok.is_ok());
        assert!(build_canonical_sheet_url("../etc/passwd", "123").is_err());
        assert!(build_canonical_sheet_url(DEFAULT_SPREADSHEET_ID, "123&evil=1").is_err());
    }

    #[test]
    fn test_csv_formula_injection_escaping() {
        assert_eq!(escape_csv_cell("=CMD()"), "'=CMD()");
        assert_eq!(escape_csv_cell("+1+1"), "'+1+1");
        assert_eq!(escape_csv_cell("-2+3"), "'-2+3");
        assert_eq!(escape_csv_cell("@SUM(A1)"), "'@SUM(A1)");
        assert_eq!(escape_csv_cell("SIDOARJO AREA"), "SIDOARJO AREA");
    }
}

