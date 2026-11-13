#![forbid(unsafe_code)]

use crate::security::sanitize_cell_text;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DrumReel {
    pub drum_index: usize,
    pub meters: u64,
    pub year: Option<u16>,
    pub year_raw: String,
    pub year_valid: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MaterialItem {
    pub row_no: String,
    pub warehouse: String,
    pub item_id: String,
    pub drums: Vec<DrumReel>,
    pub active_drum_count: usize,
    pub total_meters: u64,
    pub sheet_total: u64,
    pub total_mismatch: bool,
    pub min_year: Option<u16>,
    pub max_year: Option<u16>,
    pub status: String, // "Tersedia", "Menipis", "Kosong"
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WarehouseSummary {
    pub warehouse: String,
    pub total_meters: u64,
    pub sku_count: usize,
    pub active_drum_count: usize,
    pub out_of_stock_count: usize,
    pub share_percent: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct YearSummary {
    pub year_label: String,
    pub total_meters: u64,
    pub drum_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DataAnomaly {
    pub warehouse: String,
    pub item_id: String,
    pub kind: String,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InventoryDataset {
    pub sheet_updated_at: String,
    pub fetched_at: String,
    pub source_mode: String, // "live" or "cache"
    pub total_meters: u64,
    pub sheet_grand_total: Option<u64>,
    pub total_active_drums: usize,
    pub total_skus: usize,
    pub warehouse_count: usize,
    pub out_of_stock_count: usize,
    pub low_stock_count: usize,
    pub items: Vec<MaterialItem>,
    pub warehouses: Vec<WarehouseSummary>,
    pub years: Vec<YearSummary>,
    pub anomalies: Vec<DataAnomaly>,
    pub notes: Vec<String>,
}

fn parse_u64_clean(s: &str) -> Option<u64> {
    let cleaned: String = s
        .trim()
        .chars()
        .filter(|c| c.is_ascii_digit())
        .collect();
    if cleaned.is_empty() {
        None
    } else {
        cleaned.parse::<u64>().ok()
    }
}

pub fn parse_inventory_csv(csv_text: &str, fetched_at: String) -> Result<InventoryDataset, String> {
    let mut rdr = csv::ReaderBuilder::new()
        .has_headers(false)
        .flexible(true)
        .from_reader(csv_text.as_bytes());

    let mut rows: Vec<Vec<String>> = Vec::new();
    for result in rdr.records() {
        let record = result.map_err(|e| format!("Gagal membaca baris CSV: {}", e))?;
        let cols: Vec<String> = record
            .iter()
            .map(|c| sanitize_cell_text(c, 128))
            .collect();
        rows.push(cols);
    }

    if rows.len() < 3 {
        return Err("Data spreadsheet kosong atau format tidak sesuai".to_string());
    }

    let sheet_updated_at = rows[0]
        .first()
        .cloned()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "Tidak diketahui".to_string());

    // Locate TOTAL column index from header row (row 1)
    let header_row = &rows[1];
    let total_col_idx = header_row
        .iter()
        .position(|c| c.eq_ignore_ascii_case("TOTAL"))
        .unwrap_or(47);

    let mut items: Vec<MaterialItem> = Vec::new();
    let mut anomalies: Vec<DataAnomaly> = Vec::new();
    let mut notes: Vec<String> = Vec::new();
    let mut sheet_grand_total: Option<u64> = None;

    let mut i = 2;
    while i < rows.len() {
        let row = &rows[i];
        let col0 = row.first().map(|s| s.as_str()).unwrap_or("");
        let col1 = row.get(1).map(|s| s.as_str()).unwrap_or("");
        let col2 = row.get(2).map(|s| s.as_str()).unwrap_or("");

        // Grand TOTAL row
        if col0.eq_ignore_ascii_case("TOTAL") {
            sheet_grand_total = row.get(total_col_idx).and_then(|s| parse_u64_clean(s));
            i += 1;
            continue;
        }

        // Skip stray TAHUN KABEL row if encountered alone
        if col2.eq_ignore_ascii_case("TAHUN KABEL") {
            i += 1;
            continue;
        }

        // Footer notes (no warehouse, no item_id, or after TOTAL)
        if col1.is_empty() && !col2.is_empty() {
            notes.push(col2.to_string());
            i += 1;
            continue;
        }

        if col1.is_empty() && col2.is_empty() {
            i += 1;
            continue;
        }

        // Item row! Check if next row is TAHUN KABEL
        let year_row = if i + 1 < rows.len()
            && rows[i + 1]
                .get(2)
                .map(|s| s.eq_ignore_ascii_case("TAHUN KABEL"))
                .unwrap_or(false)
        {
            Some(&rows[i + 1])
        } else {
            None
        };

        let warehouse = col1.to_string();
        let item_id = col2.to_string();
        let row_no = if col0.is_empty() {
            "-".to_string()
        } else {
            col0.to_string()
        };

        let mut drums: Vec<DrumReel> = Vec::new();
        let mut computed_total: u64 = 0;
        let mut drum_seq = 0usize;

        for col_idx in 3..total_col_idx {
            let meter_str = row.get(col_idx).map(|s| s.as_str()).unwrap_or("");
            let year_str = year_row
                .and_then(|yr| yr.get(col_idx))
                .map(|s| s.as_str())
                .unwrap_or("");

            let meters_opt = parse_u64_clean(meter_str);
            if let Some(meters) = meters_opt {
                if meters > 0 {
                    drum_seq += 1;
                    computed_total = computed_total.saturating_add(meters);

                    let year_num = parse_u64_clean(year_str).and_then(|y| u16::try_from(y).ok());
                    let (year, year_valid) = match year_num {
                        Some(y) if (1990..=2099).contains(&y) => (Some(y), true),
                        Some(_) => {
                            anomalies.push(DataAnomaly {
                                warehouse: warehouse.clone(),
                                item_id: item_id.clone(),
                                kind: "Tahun Kabel Tidak Valid".to_string(),
                                detail: format!(
                                    "Drum #{} ({} m) memiliki nilai tahun '{}'",
                                    drum_seq, meters, year_str
                                ),
                            });
                            (None, false)
                        }
                        None => {
                            if !year_str.is_empty() {
                                anomalies.push(DataAnomaly {
                                    warehouse: warehouse.clone(),
                                    item_id: item_id.clone(),
                                    kind: "Format Tahun Tidak Valid".to_string(),
                                    detail: format!(
                                        "Drum #{} ({} m) memiliki teks tahun '{}'",
                                        drum_seq, meters, year_str
                                    ),
                                });
                            } else {
                                anomalies.push(DataAnomaly {
                                    warehouse: warehouse.clone(),
                                    item_id: item_id.clone(),
                                    kind: "Tahun Kabel Kosong".to_string(),
                                    detail: format!(
                                        "Drum #{} ({} m) belum memiliki tahun kabel",
                                        drum_seq, meters
                                    ),
                                });
                            }
                            (None, false)
                        }
                    };

                    drums.push(DrumReel {
                        drum_index: drum_seq,
                        meters,
                        year,
                        year_raw: if year_str.is_empty() {
                            "N/A".to_string()
                        } else {
                            year_str.to_string()
                        },
                        year_valid,
                    });
                }
            }
        }

        let sheet_total = row
            .get(total_col_idx)
            .and_then(|s| parse_u64_clean(s))
            .unwrap_or(0);
        let total_mismatch = computed_total != sheet_total;
        if total_mismatch {
            anomalies.push(DataAnomaly {
                warehouse: warehouse.clone(),
                item_id: item_id.clone(),
                kind: "Selisih Total".to_string(),
                detail: format!(
                    "Total hitung ({} m) berbeda dengan kolom TOTAL sheet ({} m)",
                    computed_total, sheet_total
                ),
            });
        }

        let min_year = drums.iter().filter_map(|d| d.year).min();
        let max_year = drums.iter().filter_map(|d| d.year).max();
        let active_drum_count = drums.len();
        let status = if computed_total == 0 {
            "Kosong".to_string()
        } else if computed_total < 500 {
            "Menipis".to_string()
        } else {
            "Tersedia".to_string()
        };

        items.push(MaterialItem {
            row_no,
            warehouse,
            item_id,
            drums,
            active_drum_count,
            total_meters: computed_total,
            sheet_total,
            total_mismatch,
            min_year,
            max_year,
            status,
        });

        i += if year_row.is_some() { 2 } else { 1 };
    }

    // Aggregate summaries
    let total_meters: u64 = items.iter().map(|it| it.total_meters).sum();
    if let Some(gt) = sheet_grand_total {
        if gt != total_meters {
            anomalies.push(DataAnomaly {
                warehouse: "SEMUA GUDANG".to_string(),
                item_id: "GRAND TOTAL".to_string(),
                kind: "Selisih Grand Total".to_string(),
                detail: format!(
                    "Total hitung ({} m) berbeda dengan baris TOTAL sheet ({} m)",
                    total_meters, gt
                ),
            });
        }
    }
    let total_active_drums: usize = items.iter().map(|it| it.active_drum_count).sum();
    let total_skus = items.len();
    let out_of_stock_count = items.iter().filter(|it| it.total_meters == 0).count();
    let low_stock_count = items
        .iter()
        .filter(|it| it.total_meters > 0 && it.total_meters < 500)
        .count();

    let mut wh_map: BTreeMap<String, (u64, usize, usize, usize)> = BTreeMap::new();
    let mut year_map: BTreeMap<String, (u64, usize)> = BTreeMap::new();

    for it in &items {
        let entry = wh_map.entry(it.warehouse.clone()).or_insert((0, 0, 0, 0));
        entry.0 = entry.0.saturating_add(it.total_meters);
        entry.1 += 1;
        entry.2 += it.active_drum_count;
        if it.total_meters == 0 {
            entry.3 += 1;
        }

        for drum in &it.drums {
            let y_key = match drum.year {
                Some(y) => y.to_string(),
                None => "Anomali / N/A".to_string(),
            };
            let y_entry = year_map.entry(y_key).or_insert((0, 0));
            y_entry.0 = y_entry.0.saturating_add(drum.meters);
            y_entry.1 += 1;
        }
    }

    let mut warehouses: Vec<WarehouseSummary> = wh_map
        .into_iter()
        .map(
            |(warehouse, (wh_meters, sku_count, active_drum_count, wh_oos))| WarehouseSummary {
                warehouse,
                total_meters: wh_meters,
                sku_count,
                active_drum_count,
                out_of_stock_count: wh_oos,
                share_percent: if total_meters > 0 {
                    (wh_meters as f64 / total_meters as f64) * 100.0
                } else {
                    0.0
                },
            },
        )
        .collect();
    warehouses.sort_by(|a, b| b.total_meters.cmp(&a.total_meters));

    let years: Vec<YearSummary> = year_map
        .into_iter()
        .map(|(year_label, (y_meters, drum_count))| YearSummary {
            year_label,
            total_meters: y_meters,
            drum_count,
        })
        .collect();

    let warehouse_count = warehouses.len();

    Ok(InventoryDataset {
        sheet_updated_at,
        fetched_at,
        source_mode: "live".to_string(),
        total_meters,
        sheet_grand_total,
        total_active_drums,
        total_skus,
        warehouse_count,
        out_of_stock_count,
        low_stock_count,
        items,
        warehouses,
        years,
        anomalies,
        notes,
    })
}

// ============================================================================
// INV MTC (PT-2 & Maintenance) Parser
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InvMtcItem {
    pub category: String,
    pub material: String,
    pub description: String,
    pub unit: String,
    pub location_stocks: Vec<(String, u64)>,
    pub total: u64,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GroupSummary {
    pub name: String,
    pub total_qty: u64,
    pub item_count: usize,
    pub share_percent: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InvMtcDataset {
    pub sheet_updated_at: String,
    pub fetched_at: String,
    pub source_mode: String,
    pub locations: Vec<String>,
    pub total_qty: u64,
    pub sheet_grand_total: Option<u64>,
    pub total_skus: usize,
    pub category_count: usize,
    pub out_of_stock_count: usize,
    pub items: Vec<InvMtcItem>,
    pub by_category: Vec<GroupSummary>,
    pub by_location: Vec<GroupSummary>,
    pub anomalies: Vec<DataAnomaly>,
}

pub fn parse_inv_mtc_csv(csv_text: &str, fetched_at: String) -> Result<InvMtcDataset, String> {
    let mut rdr = csv::ReaderBuilder::new()
        .has_headers(false)
        .flexible(true)
        .from_reader(csv_text.as_bytes());

    let mut rows: Vec<Vec<String>> = Vec::new();
    for result in rdr.records() {
        let record = result.map_err(|e| format!("Gagal membaca CSV INV MTC: {}", e))?;
        rows.push(
            record
                .iter()
                .map(|c| sanitize_cell_text(c, 160))
                .collect(),
        );
    }

    if rows.len() < 5 {
        return Err("Data INV MTC kosong atau format tidak sesuai".to_string());
    }

    let sheet_updated_at = rows[2]
        .get(2)
        .cloned()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "Tidak diketahui".to_string());

    let header = &rows[3];
    let total_col_idx = header
        .iter()
        .position(|h| h.eq_ignore_ascii_case("TOTAL"))
        .unwrap_or(header.len().saturating_sub(1));

    let locations: Vec<String> = (4..total_col_idx)
        .map(|idx| header.get(idx).cloned().unwrap_or_else(|| format!("Loc {}", idx)))
        .collect();

    let mut items: Vec<InvMtcItem> = Vec::new();
    let mut current_category = String::from("LAINNYA");
    let mut loc_totals: Vec<u64> = vec![0; locations.len()];
    let mut cat_map: BTreeMap<String, (u64, usize)> = BTreeMap::new();
    let mut anomalies: Vec<DataAnomaly> = Vec::new();
    let mut sheet_grand_total: Option<u64> = None;

    for row in rows.iter().skip(4) {
        let col0 = row.first().map(|s| s.as_str()).unwrap_or("");
        let material = row.get(1).map(|s| s.as_str()).unwrap_or("");
        if col0.eq_ignore_ascii_case("Total") {
            sheet_grand_total = row.get(total_col_idx).and_then(|s| parse_u64_clean(s));
            continue;
        }
        if material.is_empty() {
            continue;
        }
        if !col0.is_empty() {
            current_category = col0.to_string();
        }
        let description = row.get(2).cloned().unwrap_or_default();
        let unit = row.get(3).cloned().unwrap_or_else(|| "PC".to_string());

        let mut location_stocks: Vec<(String, u64)> = Vec::new();
        let mut computed_total = 0u64;
        for (idx, loc_name) in locations.iter().enumerate() {
            let val = row
                .get(4 + idx)
                .and_then(|s| parse_u64_clean(s))
                .unwrap_or(0);
            computed_total = computed_total.saturating_add(val);
            loc_totals[idx] = loc_totals[idx].saturating_add(val);
            location_stocks.push((loc_name.clone(), val));
        }

        let sheet_total = row
            .get(total_col_idx)
            .and_then(|s| parse_u64_clean(s))
            .unwrap_or(computed_total);
        if computed_total != sheet_total {
            anomalies.push(DataAnomaly {
                warehouse: current_category.clone(),
                item_id: material.to_string(),
                kind: "Selisih Total INV MTC".to_string(),
                detail: format!(
                    "Total hitung ({}) berbeda dengan kolom TOTAL sheet ({})",
                    computed_total, sheet_total
                ),
            });
        }
        let final_total = computed_total;

        let status = if final_total == 0 {
            "Kosong".to_string()
        } else if final_total < 10 {
            "Menipis".to_string()
        } else {
            "Tersedia".to_string()
        };

        let c_entry = cat_map.entry(current_category.clone()).or_insert((0, 0));
        c_entry.0 = c_entry.0.saturating_add(final_total);
        c_entry.1 += 1;

        items.push(InvMtcItem {
            category: current_category.clone(),
            material: material.to_string(),
            description,
            unit,
            location_stocks,
            total: final_total,
            status,
        });
    }

    let total_qty: u64 = items.iter().map(|i| i.total).sum();
    if let Some(gt) = sheet_grand_total {
        if gt != total_qty {
            anomalies.push(DataAnomaly {
                warehouse: "SEMUA LOKASI".to_string(),
                item_id: "GRAND TOTAL".to_string(),
                kind: "Selisih Grand Total INV MTC".to_string(),
                detail: format!(
                    "Total hitung ({}) berbeda dengan baris Total sheet ({})",
                    total_qty, gt
                ),
            });
        }
    }
    let total_skus = items.len();
    let out_of_stock_count = items.iter().filter(|i| i.total == 0).count();
    let category_count = cat_map.len();

    let mut by_category: Vec<GroupSummary> = cat_map
        .into_iter()
        .map(|(name, (qty, count))| GroupSummary {
            name,
            total_qty: qty,
            item_count: count,
            share_percent: if total_qty > 0 {
                (qty as f64 / total_qty as f64) * 100.0
            } else {
                0.0
            },
        })
        .collect();
    by_category.sort_by(|a, b| b.total_qty.cmp(&a.total_qty));

    let mut by_location: Vec<GroupSummary> = locations
        .iter()
        .enumerate()
        .map(|(idx, name)| {
            let qty = loc_totals[idx];
            let active_items = items.iter().filter(|it| it.location_stocks[idx].1 > 0).count();
            GroupSummary {
                name: name.clone(),
                total_qty: qty,
                item_count: active_items,
                share_percent: if total_qty > 0 {
                    (qty as f64 / total_qty as f64) * 100.0
                } else {
                    0.0
                },
            }
        })
        .collect();
    by_location.sort_by(|a, b| b.total_qty.cmp(&a.total_qty));

    Ok(InvMtcDataset {
        sheet_updated_at,
        fetched_at,
        source_mode: "live".to_string(),
        locations,
        total_qty,
        sheet_grand_total,
        total_skus,
        category_count,
        out_of_stock_count,
        items,
        by_category,
        by_location,
        anomalies,
    })
}

// ============================================================================
// INVALL (Master All Inventory) Parser
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InvallItem {
    pub witel: String,
    pub branch: String,
    pub area_name: String,
    pub material: String,
    pub description: String,
    pub category: String,
    pub qty: u64,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InvallDataset {
    pub fetched_at: String,
    pub source_mode: String,
    pub total_qty: u64,
    pub total_rows: usize,
    pub active_rows: usize,
    pub out_of_stock_rows: usize,
    pub area_count: usize,
    pub category_count: usize,
    pub items: Vec<InvallItem>,
    pub by_area: Vec<GroupSummary>,
    pub by_category: Vec<GroupSummary>,
}

pub fn parse_invall_csv(csv_text: &str, fetched_at: String) -> Result<InvallDataset, String> {
    let mut rdr = csv::ReaderBuilder::new()
        .has_headers(true)
        .flexible(true)
        .from_reader(csv_text.as_bytes());

    let mut items: Vec<InvallItem> = Vec::new();
    let mut area_map: BTreeMap<String, (u64, usize)> = BTreeMap::new();
    let mut cat_map: BTreeMap<String, (u64, usize)> = BTreeMap::new();

    for result in rdr.records() {
        let record = result.map_err(|e| format!("Gagal membaca CSV INVALL: {}", e))?;
        let witel = sanitize_cell_text(record.get(0).unwrap_or(""), 64);
        let branch = sanitize_cell_text(record.get(1).unwrap_or(""), 64);
        let area_name = sanitize_cell_text(record.get(2).unwrap_or(""), 64);
        let material = sanitize_cell_text(record.get(3).unwrap_or(""), 96);
        let description = sanitize_cell_text(record.get(4).unwrap_or(""), 180);
        let category = sanitize_cell_text(record.get(5).unwrap_or(""), 96);
        let qty = record
            .get(6)
            .and_then(|s| parse_u64_clean(s))
            .unwrap_or(0);

        if material.is_empty() {
            continue;
        }

        let status = if qty == 0 {
            "Kosong".to_string()
        } else {
            "Tersedia".to_string()
        };

        let a_entry = area_map.entry(area_name.clone()).or_insert((0, 0));
        a_entry.0 = a_entry.0.saturating_add(qty);
        a_entry.1 += 1;

        let c_entry = cat_map.entry(category.clone()).or_insert((0, 0));
        c_entry.0 = c_entry.0.saturating_add(qty);
        c_entry.1 += 1;

        items.push(InvallItem {
            witel,
            branch,
            area_name,
            material,
            description,
            category,
            qty,
            status,
        });
    }

    let total_qty: u64 = items.iter().map(|i| i.qty).sum();
    let total_rows = items.len();
    let active_rows = items.iter().filter(|i| i.qty > 0).count();
    let out_of_stock_rows = total_rows.saturating_sub(active_rows);
    let area_count = area_map.len();
    let category_count = cat_map.len();

    let mut by_area: Vec<GroupSummary> = area_map
        .into_iter()
        .map(|(name, (qty, count))| GroupSummary {
            name,
            total_qty: qty,
            item_count: count,
            share_percent: if total_qty > 0 {
                (qty as f64 / total_qty as f64) * 100.0
            } else {
                0.0
            },
        })
        .collect();
    by_area.sort_by(|a, b| b.total_qty.cmp(&a.total_qty));

    let mut by_category: Vec<GroupSummary> = cat_map
        .into_iter()
        .map(|(name, (qty, count))| GroupSummary {
            name,
            total_qty: qty,
            item_count: count,
            share_percent: if total_qty > 0 {
                (qty as f64 / total_qty as f64) * 100.0
            } else {
                0.0
            },
        })
        .collect();
    by_category.sort_by(|a, b| b.total_qty.cmp(&a.total_qty));

    Ok(InvallDataset {
        fetched_at,
        source_mode: "live".to_string(),
        total_qty,
        total_rows,
        active_rows,
        out_of_stock_rows,
        area_count,
        category_count,
        items,
        by_area,
        by_category,
    })
}

