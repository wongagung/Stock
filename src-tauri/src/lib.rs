#![forbid(unsafe_code)]

mod parser;
mod security;

use chrono::Local;
use parser::{
    parse_inv_mtc_csv, parse_invall_csv, parse_inventory_csv, InvMtcDataset, InvallDataset,
    InventoryDataset,
};
use security::{
    compute_sha256_hex, current_security_posture, escape_csv_cell, fetch_verified_csv,
    load_verified_cache, save_signed_cache, SecurityPosture, SheetKind, DEFAULT_SPREADSHEET_ID,
};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::Manager;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", content = "data")]
pub enum SheetPayload {
    PotonganKu(InventoryDataset),
    InvMtc(InvMtcDataset),
    Invall(InvallDataset),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CachedSheetRecord {
    pub content_hash: String,
    pub payload: SheetPayload,
}

#[derive(Debug, Clone, Serialize)]
pub struct SheetFetchResponse {
    pub changed: bool,
    pub content_hash: String,
    pub checked_at: String,
    pub payload: Option<SheetPayload>,
}

#[tauri::command]
async fn fetch_sheet_data(
    app: tauri::AppHandle,
    sheet: SheetKind,
    previous_hash: Option<String>,
) -> Result<SheetFetchResponse, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Gagal mengakses direktori data aplikasi: {}", e))?;

    let checked_at = Local::now().format("%H:%M:%S").to_string();
    let cache_key = sheet.cache_key();

    match fetch_verified_csv(DEFAULT_SPREADSHEET_ID, sheet.gid()).await {
        Ok(csv_text) => {
            let content_hash = compute_sha256_hex(&csv_text);
            if previous_hash.as_deref() == Some(content_hash.as_str()) {
                return Ok(SheetFetchResponse {
                    changed: false,
                    content_hash,
                    checked_at,
                    payload: None,
                });
            }

            let now_str = Local::now().format("%d/%m/%Y %H:%M:%S").to_string();
            let payload = match sheet {
                SheetKind::PotonganKu => {
                    SheetPayload::PotonganKu(parse_inventory_csv(&csv_text, now_str)?)
                }
                SheetKind::InvMtc => SheetPayload::InvMtc(parse_inv_mtc_csv(&csv_text, now_str)?),
                SheetKind::Invall => SheetPayload::Invall(parse_invall_csv(&csv_text, now_str)?),
            };

            let record = CachedSheetRecord {
                content_hash: content_hash.clone(),
                payload: payload.clone(),
            };
            let _ = save_signed_cache(&app_data_dir, cache_key, &record);

            Ok(SheetFetchResponse {
                changed: true,
                content_hash,
                checked_at,
                payload: Some(payload),
            })
        }
        Err(live_err) => {
            // If we already have data in memory, keep it without failing the background poll
            if previous_hash.is_some() {
                return Err(format!("Sinkronisasi gagal (offline/timeout): {}", live_err));
            }
            match load_verified_cache::<CachedSheetRecord>(&app_data_dir, cache_key) {
                Ok(Some((mut record, _ts))) => {
                    match &mut record.payload {
                        SheetPayload::PotonganKu(d) => d.source_mode = "cache".to_string(),
                        SheetPayload::InvMtc(d) => d.source_mode = "cache".to_string(),
                        SheetPayload::Invall(d) => d.source_mode = "cache".to_string(),
                    }
                    Ok(SheetFetchResponse {
                        changed: true,
                        content_hash: record.content_hash,
                        checked_at,
                        payload: Some(record.payload),
                    })
                }
                Ok(None) => Err(format!(
                    "Gagal mengambil data live ({}) dan belum ada cache lokal.",
                    live_err
                )),
                Err(cache_err) => Err(format!(
                    "Gagal mengambil data live ({}) dan cache ditolak ({}).",
                    live_err, cache_err
                )),
            }
        }
    }
}

#[tauri::command]
async fn export_generic_csv(
    app: tauri::AppHandle,
    sheet_name: String,
    headers: Vec<String>,
    rows: Vec<Vec<String>>,
) -> Result<String, String> {
    if rows.len() > 50_000 || headers.len() > 40 {
        return Err("Ukuran ekspor melebihi batas aman".to_string());
    }

    let base_dir: PathBuf = app
        .path()
        .download_dir()
        .or_else(|_| app.path().app_data_dir())
        .map_err(|e| format!("Direktori ekspor tidak tersedia: {}", e))?;

    fs::create_dir_all(&base_dir).map_err(|e| format!("Gagal membuat direktori: {}", e))?;

    let safe_sheet: String = sheet_name
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
        .collect();
    let filename = format!(
        "stock-{}-{}.csv",
        if safe_sheet.is_empty() { "material" } else { &safe_sheet },
        Local::now().format("%Y%m%d-%H%M%S")
    );
    let target_path = base_dir.join(filename);

    let mut out = String::new();
    let header_line: Vec<String> = headers.iter().map(|h| escape_csv_cell(h)).collect();
    out.push_str(&header_line.join(","));
    out.push('\n');

    for row in rows {
        let escaped: Vec<String> = row.iter().map(|cell| escape_csv_cell(cell)).collect();
        out.push_str(&escaped.join(","));
        out.push('\n');
    }

    fs::write(&target_path, out.as_bytes())
        .map_err(|e| format!("Gagal menyimpan file CSV: {}", e))?;

    Ok(target_path.to_string_lossy().into_owned())
}

#[tauri::command]
fn get_security_status() -> SecurityPosture {
    current_security_posture()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            fetch_sheet_data,
            export_generic_csv,
            get_security_status
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
