export type SheetKind = "potongan_ku" | "inv_mtc" | "invall";

export interface DrumReel {
  drum_index: number;
  meters: number;
  year: number | null;
  year_raw: string;
  year_valid: boolean;
}

export interface MaterialItem {
  row_no: string;
  warehouse: string;
  item_id: string;
  drums: DrumReel[];
  active_drum_count: number;
  total_meters: number;
  sheet_total: number;
  total_mismatch: boolean;
  min_year: number | null;
  max_year: number | null;
  status: "Tersedia" | "Menipis" | "Kosong" | string;
}

export interface WarehouseSummary {
  warehouse: string;
  total_meters: number;
  sku_count: number;
  active_drum_count: number;
  out_of_stock_count: number;
  share_percent: number;
}

export interface YearSummary {
  year_label: string;
  total_meters: number;
  drum_count: number;
}

export interface DataAnomaly {
  warehouse: string;
  item_id: string;
  kind: string;
  detail: string;
}

export interface InventoryDataset {
  sheet_updated_at: string;
  fetched_at: string;
  source_mode: string;
  total_meters: number;
  sheet_grand_total: number | null;
  total_active_drums: number;
  total_skus: number;
  warehouse_count: number;
  out_of_stock_count: number;
  low_stock_count: number;
  items: MaterialItem[];
  warehouses: WarehouseSummary[];
  years: YearSummary[];
  anomalies: DataAnomaly[];
  notes: string[];
}

export interface GroupSummary {
  name: string;
  total_qty: number;
  item_count: number;
  share_percent: number;
}

export interface InvMtcItem {
  category: string;
  material: string;
  description: string;
  unit: string;
  location_stocks: [string, number][];
  total: number;
  status: string;
}

export interface InvMtcDataset {
  sheet_updated_at: string;
  fetched_at: string;
  source_mode: string;
  locations: string[];
  total_qty: number;
  sheet_grand_total: number | null;
  total_skus: number;
  category_count: number;
  out_of_stock_count: number;
  items: InvMtcItem[];
  by_category: GroupSummary[];
  by_location: GroupSummary[];
  anomalies: DataAnomaly[];
}

export interface InvallItem {
  witel: string;
  branch: string;
  area_name: string;
  material: string;
  description: string;
  category: string;
  qty: number;
  status: string;
}

export interface InvallDataset {
  fetched_at: string;
  source_mode: string;
  total_qty: number;
  total_rows: number;
  active_rows: number;
  out_of_stock_rows: number;
  area_count: number;
  category_count: number;
  items: InvallItem[];
  by_area: GroupSummary[];
  by_category: GroupSummary[];
}

export type SheetPayload =
  | { kind: "PotonganKu"; data: InventoryDataset }
  | { kind: "InvMtc"; data: InvMtcDataset }
  | { kind: "Invall"; data: InvallDataset };

export interface SheetFetchResponse {
  changed: boolean;
  content_hash: string;
  checked_at: string;
  payload: SheetPayload | null;
}

export interface SecurityPosture {
  tls_enforced: string;
  csp_policy: string;
  ssrf_allowlist: string[];
  cache_integrity: string;
  unsafe_rust_forbidden: boolean;
  csv_formula_protection: boolean;
  max_payload_mb: number;
}
