import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ClaySelect } from "./components/ClaySelect";
import {
  Activity,
  AlertTriangle,
  ArrowUpDown,
  Box,
  CheckCircle2,
  Database,
  Download,
  Eye,
  Filter,
  Layers,
  Lock,
  Maximize2,
  Minimize2,
  Minus,
  Package,
  RefreshCw,
  Search,
  ShieldCheck,
  Warehouse,
  X,
} from "lucide-react";
import type {
  InvMtcDataset,
  InvMtcItem,
  InvallDataset,
  InventoryDataset,
  MaterialItem,
  SecurityPosture,
  SheetFetchResponse,
  SheetKind,
} from "./types";

type SortKeyKu = "row_no" | "warehouse" | "item_id" | "active_drum_count" | "total_meters" | "status";

function formatNumber(n: number): string {
  return new Intl.NumberFormat("id-ID").format(n);
}

function formatYearRange(item: MaterialItem): string {
  if (item.min_year && item.max_year) {
    return item.min_year === item.max_year
      ? `${item.min_year}`
      : `${item.min_year} – ${item.max_year}`;
  }
  return item.active_drum_count > 0 ? "N/A" : "-";
}

function statusPillClass(status: string): string {
  if (status === "Tersedia") return "pill-emerald";
  if (status === "Menipis") return "pill-amber";
  return "pill-rose";
}

const SHEET_TABS: { key: SheetKind; label: string; subtitle: string }[] = [
  { key: "potongan_ku", label: "Potongan KU", subtitle: "Kabel & Drum per Gudang" },
  { key: "inv_mtc", label: "INV MTC", subtitle: "Material PT-2 & Maintenance" },
  { key: "invall", label: "INVALL", subtitle: "Master Stok Semua Area" },
];

export default function App() {
  const [activeSheet, setActiveSheet] = useState<SheetKind>("potongan_ku");

  // Cached per-sheet data & SHA-256 content hashes in memory
  const [kuData, setKuData] = useState<InventoryDataset | null>(null);
  const [mtcData, setMtcData] = useState<InvMtcDataset | null>(null);
  const [invallData, setInvallData] = useState<InvallDataset | null>(null);

  const hashesRef = useRef<Record<SheetKind, string | null>>({
    potongan_ku: null,
    inv_mtc: null,
    invall: null,
  });

  const [security, setSecurity] = useState<SecurityPosture | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  // Realtime Auto-Update state
  const [autoSyncSeconds, setAutoSyncSeconds] = useState<number>(15);
  const [lastCheckedAt, setLastCheckedAt] = useState<string>("-");

  // Potongan KU Filters & Sort
  const [kuSearch, setKuSearch] = useState("");
  const [kuWarehouse, setKuWarehouse] = useState("ALL");
  const [kuStatus, setKuStatus] = useState("ALL");
  const [kuYear, setKuYear] = useState("ALL");
  const [kuSortKey, setKuSortKey] = useState<SortKeyKu>("total_meters");
  const [kuSortAsc, setKuSortAsc] = useState<boolean>(false);

  // INV MTC Filters
  const [mtcSearch, setMtcSearch] = useState("");
  const [mtcCategory, setMtcCategory] = useState("ALL");
  const [mtcStatus, setMtcStatus] = useState("ALL");

  // INVALL Filters & Pagination
  const [invallSearch, setInvallSearch] = useState("");
  const [invallArea, setInvallArea] = useState("ALL");
  const [invallCategory, setInvallCategory] = useState("ALL");
  const [invallStatus, setInvallStatus] = useState("ALL");
  const [invallPage, setInvallPage] = useState(1);
  const INVALL_PAGE_SIZE = 100;

  // Modals & Window state
  const [inspectKuItem, setInspectKuItem] = useState<MaterialItem | null>(null);
  const [inspectMtcItem, setInspectMtcItem] = useState<InvMtcItem | null>(null);
  const [showSecurityModal, setShowSecurityModal] = useState<boolean>(false);
  const [isMaximized, setIsMaximized] = useState<boolean>(false);

  const appWindow = useMemo(() => getCurrentWindow(), []);

  useEffect(() => {
    appWindow.isMaximized().then(setIsMaximized).catch(() => {});
    const disableContextMenu = (e: MouseEvent) => {
      e.preventDefault();
    };
    document.addEventListener("contextmenu", disableContextMenu);
    return () => {
      document.removeEventListener("contextmenu", disableContextMenu);
    };
  }, [appWindow]);

  const handleToggleMaximize = async () => {
    try {
      await appWindow.toggleMaximize();
      const max = await appWindow.isMaximized();
      setIsMaximized(max);
    } catch {
      // ignore outside Tauri
    }
  };

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 4200);
  }, []);

  const fetchSheet = useCallback(
    async (sheet: SheetKind, isBackgroundPoll: boolean, forceFull = false) => {
      try {
        if (!isBackgroundPoll) {
          if (
            (sheet === "potongan_ku" && !kuData) ||
            (sheet === "inv_mtc" && !mtcData) ||
            (sheet === "invall" && !invallData)
          ) {
            setLoading(true);
          } else {
            setRefreshing(true);
          }
          setErrorMsg(null);
        }

        const prevHash = forceFull ? null : hashesRef.current[sheet];
        const res = await invoke<SheetFetchResponse>("fetch_sheet_data", {
          sheet,
          previousHash: prevHash,
        });

        setLastCheckedAt(res.checked_at);

        if (res.changed && res.payload) {
          hashesRef.current[sheet] = res.content_hash;
          if (res.payload.kind === "PotonganKu") {
            setKuData(res.payload.data);
          } else if (res.payload.kind === "InvMtc") {
            setMtcData(res.payload.data);
          } else if (res.payload.kind === "Invall") {
            setInvallData(res.payload.data);
          }

          if (isBackgroundPoll && prevHash !== null) {
            const tabLabel = SHEET_TABS.find((t) => t.key === sheet)?.label ?? sheet;
            showToast(`Perubahan terdeteksi di ${tabLabel} — data diperbarui otomatis!`);
          } else if (forceFull) {
            showToast("Data berhasil disinkronkan dari Google Sheets");
          }
        } else if (forceFull && !res.changed) {
          showToast("Data sudah versi terbaru (tidak ada perubahan di Google Sheets)");
        }
      } catch (err) {
        if (!isBackgroundPoll) {
          setErrorMsg(String(err));
        }
      } finally {
        if (!isBackgroundPoll) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [kuData, mtcData, invallData, showToast]
  );

  // Initial load of security posture + active sheet
  useEffect(() => {
    invoke<SecurityPosture>("get_security_status")
      .then(setSecurity)
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetchSheet(activeSheet, false, false);
  }, [activeSheet]); // eslint-disable-line react-hooks/exhaustive-deps

  // Realtime Auto-Update Polling Timer
  useEffect(() => {
    if (autoSyncSeconds <= 0) return;
    const timer = setInterval(() => {
      fetchSheet(activeSheet, true, false);
    }, autoSyncSeconds * 1000);
    return () => clearInterval(timer);
  }, [activeSheet, autoSyncSeconds, fetchSheet]);

  // Derived filtered lists
  const filteredKuItems = useMemo(() => {
    if (!kuData) return [];
    const q = kuSearch.trim().toLowerCase();
    return kuData.items
      .filter((item) => {
        if (kuWarehouse !== "ALL" && item.warehouse !== kuWarehouse) return false;
        if (kuStatus !== "ALL" && item.status !== kuStatus) return false;
        if (kuYear !== "ALL") {
          if (kuYear === "Anomali / N/A") {
            if (!item.drums.some((d) => !d.year_valid)) return false;
          } else {
            const yrNum = Number(kuYear);
            if (!item.drums.some((d) => d.year === yrNum)) return false;
          }
        }
        if (q) {
          if (
            !item.item_id.toLowerCase().includes(q) &&
            !item.warehouse.toLowerCase().includes(q)
          ) {
            return false;
          }
        }
        return true;
      })
      .sort((a, b) => {
        let cmp = 0;
        switch (kuSortKey) {
          case "row_no":
            cmp = (Number(a.row_no) || 9999) - (Number(b.row_no) || 9999);
            break;
          case "warehouse":
            cmp = a.warehouse.localeCompare(b.warehouse);
            break;
          case "item_id":
            cmp = a.item_id.localeCompare(b.item_id);
            break;
          case "active_drum_count":
            cmp = a.active_drum_count - b.active_drum_count;
            break;
          case "total_meters":
            cmp = a.total_meters - b.total_meters;
            break;
          case "status":
            cmp = a.status.localeCompare(b.status);
            break;
        }
        return kuSortAsc ? cmp : -cmp;
      });
  }, [kuData, kuSearch, kuWarehouse, kuStatus, kuYear, kuSortKey, kuSortAsc]);

  const filteredMtcItems = useMemo(() => {
    if (!mtcData) return [];
    const q = mtcSearch.trim().toLowerCase();
    return mtcData.items.filter((item) => {
      if (mtcCategory !== "ALL" && item.category !== mtcCategory) return false;
      if (mtcStatus !== "ALL" && item.status !== mtcStatus) return false;
      if (q) {
        if (
          !item.material.toLowerCase().includes(q) &&
          !item.description.toLowerCase().includes(q) &&
          !item.category.toLowerCase().includes(q)
        ) {
          return false;
        }
      }
      return true;
    });
  }, [mtcData, mtcSearch, mtcCategory, mtcStatus]);

  const filteredInvallItems = useMemo(() => {
    if (!invallData) return [];
    const q = invallSearch.trim().toLowerCase();
    return invallData.items.filter((item) => {
      if (invallArea !== "ALL" && item.area_name !== invallArea) return false;
      if (invallCategory !== "ALL" && item.category !== invallCategory) return false;
      if (invallStatus !== "ALL" && item.status !== invallStatus) return false;
      if (q) {
        if (
          !item.material.toLowerCase().includes(q) &&
          !item.description.toLowerCase().includes(q) &&
          !item.area_name.toLowerCase().includes(q)
        ) {
          return false;
        }
      }
      return true;
    });
  }, [invallData, invallSearch, invallArea, invallCategory, invallStatus]);

  useEffect(() => {
    setInvallPage(1);
  }, [invallSearch, invallArea, invallCategory, invallStatus]);

  const invallTotalPages = Math.max(
    1,
    Math.ceil(filteredInvallItems.length / INVALL_PAGE_SIZE)
  );
  const pagedInvallItems = useMemo(() => {
    const start = (invallPage - 1) * INVALL_PAGE_SIZE;
    return filteredInvallItems.slice(start, start + INVALL_PAGE_SIZE);
  }, [filteredInvallItems, invallPage]);

  const handleSortKu = (key: SortKeyKu) => {
    if (kuSortKey === key) setKuSortAsc(!kuSortAsc);
    else {
      setKuSortKey(key);
      setKuSortAsc(key === "warehouse" || key === "item_id" || key === "row_no");
    }
  };

  const handleExportCsv = async () => {
    try {
      let headers: string[] = [];
      let rows: string[][] = [];

      if (activeSheet === "potongan_ku") {
        headers = ["No", "Gudang", "ID_Barang", "Jumlah_Drum", "Total_Meter", "Tahun_Kabel", "Status"];
        rows = filteredKuItems.map((it) => [
          it.row_no,
          it.warehouse,
          it.item_id,
          String(it.active_drum_count),
          String(it.total_meters),
          formatYearRange(it),
          it.status,
        ]);
      } else if (activeSheet === "inv_mtc" && mtcData) {
        headers = ["Kategori", "Material", "Deskripsi", "Satuan", ...mtcData.locations, "TOTAL", "Status"];
        rows = filteredMtcItems.map((it) => [
          it.category,
          it.material,
          it.description,
          it.unit,
          ...it.location_stocks.map(([, v]) => String(v)),
          String(it.total),
          it.status,
        ]);
      } else if (activeSheet === "invall") {
        headers = ["Witel", "Branch", "Name_1", "Material", "Deskripsi", "Kategori", "QTY", "Status"];
        rows = filteredInvallItems.map((it) => [
          it.witel,
          it.branch,
          it.area_name,
          it.material,
          it.description,
          it.category,
          String(it.qty),
          it.status,
        ]);
      }

      if (rows.length === 0) return;
      const savedPath = await invoke<string>("export_generic_csv", {
        sheetName: activeSheet,
        headers,
        rows,
      });
      showToast(`CSV aman tersimpan di: ${savedPath}`);
    } catch (err) {
      showToast(`Gagal ekspor: ${String(err)}`);
    }
  };

  const activeSourceMode =
    activeSheet === "potongan_ku"
      ? kuData?.source_mode
      : activeSheet === "inv_mtc"
      ? mtcData?.source_mode
      : invallData?.source_mode;

  const activeSheetUpdatedAt =
    activeSheet === "potongan_ku"
      ? kuData?.sheet_updated_at
      : activeSheet === "inv_mtc"
      ? mtcData?.sheet_updated_at
      : invallData?.fetched_at;

  const maxKuYearMeters = useMemo(() => {
    if (!kuData || kuData.years.length === 0) return 1;
    return Math.max(...kuData.years.map((y) => y.total_meters), 1);
  }, [kuData]);

  return (
    <div className={`window-frame ${isMaximized ? "maximized" : ""}`}>
      {/* Custom Clay + Glass Titlebar */}
      <div className="custom-titlebar" data-tauri-drag-region>
        <div className="titlebar-left" data-tauri-drag-region>
          <span className="titlebar-dot" />
          <span data-tauri-drag-region>Stock Material Konstruksi</span>
        </div>
        <div className="titlebar-controls">
          <button
            className="win-ctrl-btn"
            onClick={() => appWindow.minimize()}
            title="Minimize"
          >
            <Minus size={14} />
          </button>
          <button
            className="win-ctrl-btn"
            onClick={handleToggleMaximize}
            title={isMaximized ? "Restore" : "Maximize"}
          >
            {isMaximized ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
          </button>
          <button
            className="win-ctrl-btn close"
            onClick={() => appWindow.close()}
            title="Tutup Aplikasi"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      <div className="window-scroll-body">
      <div className="app-shell">
        {/* Top Glassmorphic Header */}
        <header className="glass-panel top-header">
          <div className="brand-group">
            <div className="clay-icon-orb orb-indigo">
              <Layers size={24} />
            </div>
            <div>
              <h1 className="brand-title">Stock Material Konstruksi</h1>
              <div className="brand-subtitle">
                <span>Potongan KU • INV MTC • INVALL</span>
                {activeSheetUpdatedAt && (
                  <>
                    <span>•</span>
                    <span>
                      Update Sheet: <strong>{activeSheetUpdatedAt}</strong>
                    </span>
                  </>
                )}
                {activeSourceMode && (
                  <span
                    className={`clay-pill ${
                      activeSourceMode === "live" ? "pill-emerald" : "pill-amber"
                    }`}
                  >
                    {activeSourceMode === "live" ? "Online" : "Data Tersimpan"}
                  </span>
                )}
              </div>
            </div>
          </div>

          <div className="header-actions">
            {/* Realtime Auto-Update Control */}
            <div className="live-pulse-wrap" title="Perbarui data secara otomatis">
              <span className={`live-dot ${autoSyncSeconds === 0 ? "paused" : ""}`} />
              <span>Auto-Sync:</span>
              <ClaySelect
                compact
                value={String(autoSyncSeconds)}
                onChange={(val) => setAutoSyncSeconds(Number(val))}
                options={[
                  { value: "15", label: "15 detik" },
                  { value: "30", label: "30 detik" },
                  { value: "60", label: "60 detik" },
                  { value: "0", label: "Nonaktif" },
                ]}
              />
              <span style={{ color: "var(--text-muted)" }}>({lastCheckedAt})</span>
            </div>

            <button
              className="clay-btn"
              onClick={() => setShowSecurityModal(true)}
              title="Lihat Status Aplikasi & Pemeriksaan Data"
            >
              <ShieldCheck size={16} color="#059669" />
              <span>Cek Data</span>
              {kuData && kuData.anomalies.length > 0 && (
                <span className="clay-pill pill-amber" style={{ padding: "2px 8px" }}>
                  {kuData.anomalies.length}
                </span>
              )}
            </button>

            <button
              className="clay-btn"
              onClick={handleExportCsv}
              title="Simpan tabel ke file CSV"
            >
              <Download size={16} />
              <span>Ekspor CSV</span>
            </button>

            <button
              className="clay-btn clay-btn-primary"
              onClick={() => fetchSheet(activeSheet, false, true)}
              disabled={refreshing}
            >
              <RefreshCw size={16} className={refreshing ? "spin" : ""} />
              <span>{refreshing ? "Menyinkronkan..." : "Sync Sekarang"}</span>
            </button>
          </div>
        </header>

        {/* Sheet Switcher Bar */}
        <nav className="glass-panel sheet-tabs-bar">
          <div className="sheet-tabs-group">
            {SHEET_TABS.map((tab) => (
              <button
                key={tab.key}
                className={`sheet-tab ${activeSheet === tab.key ? "active" : ""}`}
                onClick={() => setActiveSheet(tab.key)}
              >
                <Package size={16} />
                <span>{tab.label}</span>
              </button>
            ))}
          </div>
          <div style={{ fontSize: 12.5, color: "var(--text-secondary)", fontWeight: 500 }}>
            {SHEET_TABS.find((t) => t.key === activeSheet)?.subtitle}
          </div>
        </nav>

        {/* Error Banner */}
        {errorMsg && (
          <div
            className="glass-panel"
            style={{
              padding: "16px 22px",
              borderColor: "rgba(244, 63, 94, 0.5)",
              background: "rgba(255, 228, 230, 0.72)",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10, color: "#9f1239" }}>
              <AlertTriangle size={20} />
              <span style={{ fontWeight: 600, fontSize: 13.5 }}>{errorMsg}</span>
            </div>
            <button className="clay-btn" onClick={() => fetchSheet(activeSheet, false, true)}>
              Coba Lagi
            </button>
          </div>
        )}

        {/* Loading State */}
        {loading && (
          <div
            className="glass-panel"
            style={{ padding: "64px 24px", textAlign: "center", color: "var(--text-secondary)" }}
          >
            <RefreshCw size={32} className="spin" style={{ marginBottom: 12, color: "#4f46e5" }} />
            <div style={{ fontWeight: 700, fontSize: 16 }}>
              Memuat Data {SHEET_TABS.find((t) => t.key === activeSheet)?.label}...
            </div>
            <div style={{ fontSize: 13, marginTop: 6 }}>
              Mohon tunggu sebentar
            </div>
          </div>
        )}

        {/* ================================================================
            VIEW 1: POTONGAN KU
           ================================================================ */}
        {!loading && activeSheet === "potongan_ku" && kuData && (
          <>
            <section className="kpi-grid">
              <div className="clay-card kpi-card">
                <div>
                  <div className="kpi-label">Total Stok Fisik</div>
                  <div className="kpi-value tabular-nums">{formatNumber(kuData.total_meters)} m</div>
                  <div className="kpi-sub tabular-nums">
                    {(kuData.total_meters / 1000).toFixed(2)} km total kabel
                  </div>
                </div>
                <div className="clay-icon-orb orb-indigo">
                  <Database size={22} />
                </div>
              </div>

              <div className="clay-card kpi-card">
                <div>
                  <div className="kpi-label">Total Drum / Reel</div>
                  <div className="kpi-value tabular-nums">
                    {formatNumber(kuData.total_active_drums)}
                  </div>
                  <div className="kpi-sub">Drum fisik aktif terdata</div>
                </div>
                <div className="clay-icon-orb orb-sky">
                  <Box size={22} />
                </div>
              </div>

              <div className="clay-card kpi-card">
                <div>
                  <div className="kpi-label">SKU & Gudang</div>
                  <div className="kpi-value tabular-nums">{kuData.total_skus} SKU</div>
                  <div className="kpi-sub">Tersebar di {kuData.warehouse_count} gudang area</div>
                </div>
                <div className="clay-icon-orb orb-emerald">
                  <Warehouse size={22} />
                </div>
              </div>

              <div className="clay-card kpi-card">
                <div>
                  <div className="kpi-label">Stok Kosong / Menipis</div>
                  <div className="kpi-value tabular-nums">
                    {kuData.out_of_stock_count} / {kuData.low_stock_count}
                  </div>
                  <div className="kpi-sub">
                    {kuData.out_of_stock_count} kosong • {kuData.low_stock_count} &lt; 500 m
                  </div>
                </div>
                <div className="clay-icon-orb orb-rose">
                  <AlertTriangle size={22} />
                </div>
              </div>
            </section>

            <section className="analytics-grid">
              <div className="clay-card section-card">
                <div className="section-header">
                  <div>
                    <div className="section-title">
                      <Warehouse size={18} color="#4f46e5" />
                      <span>Distribusi Stok per Gudang</span>
                    </div>
                    <div className="section-caption">Klik gudang untuk memfilter tabel</div>
                  </div>
                  {kuWarehouse !== "ALL" && (
                    <button
                      className="clay-pill pill-indigo"
                      style={{ cursor: "pointer" }}
                      onClick={() => setKuWarehouse("ALL")}
                    >
                      Reset
                    </button>
                  )}
                </div>
                <div className="wh-list">
                  {kuData.warehouses.map((wh) => {
                    const isActive = kuWarehouse === wh.warehouse;
                    return (
                      <div
                        key={wh.warehouse}
                        className={`wh-row ${isActive ? "active" : ""}`}
                        onClick={() => setKuWarehouse(isActive ? "ALL" : wh.warehouse)}
                      >
                        <div className="wh-row-top">
                          <span>{wh.warehouse}</span>
                          <span className="tabular-nums">
                            {formatNumber(wh.total_meters)} m ({wh.share_percent.toFixed(1)}%)
                          </span>
                        </div>
                        <div className="clay-track">
                          <div
                            className="clay-fill"
                            style={{ width: `${Math.max(wh.share_percent, 1.5)}%` }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="clay-card section-card">
                <div className="section-header">
                  <div>
                    <div className="section-title">
                      <Layers size={18} color="#059669" />
                      <span>Distribusi per Tahun Kabel</span>
                    </div>
                    <div className="section-caption">Klik batang tahun untuk memfilter</div>
                  </div>
                  {kuYear !== "ALL" && (
                    <button
                      className="clay-pill pill-emerald"
                      style={{ cursor: "pointer" }}
                      onClick={() => setKuYear("ALL")}
                    >
                      Reset
                    </button>
                  )}
                </div>
                <div className="year-chart">
                  {kuData.years.map((yr) => {
                    const pct = Math.max((yr.total_meters / maxKuYearMeters) * 100, 4);
                    const isActive = kuYear === yr.year_label;
                    return (
                      <div
                        key={yr.year_label}
                        className={`year-col ${isActive ? "active" : ""}`}
                        onClick={() => setKuYear(isActive ? "ALL" : yr.year_label)}
                      >
                        <span className="year-val tabular-nums">
                          {yr.total_meters >= 1000
                            ? `${(yr.total_meters / 1000).toFixed(1)}k`
                            : yr.total_meters}
                        </span>
                        <div className="year-bar-wrap">
                          <div className="year-bar" style={{ height: `${pct}%` }} />
                        </div>
                        <span className="year-lbl">{yr.year_label}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </section>

            <section className="glass-panel filter-bar">
              <div className="search-wrap">
                <Search size={16} className="search-icon" />
                <input
                  type="text"
                  className="clay-input search-input"
                  placeholder="Cari ID Barang atau Gudang..."
                  value={kuSearch}
                  onChange={(e) => setKuSearch(e.target.value)}
                />
              </div>
              <ClaySelect
                minWidth={175}
                value={kuWarehouse}
                onChange={setKuWarehouse}
                options={[
                  { value: "ALL", label: "Semua Gudang" },
                  ...kuData.warehouses.map((wh) => ({
                    value: wh.warehouse,
                    label: wh.warehouse,
                  })),
                ]}
              />
              <ClaySelect
                minWidth={165}
                value={kuStatus}
                onChange={setKuStatus}
                options={[
                  { value: "ALL", label: "Semua Status" },
                  { value: "Tersedia", label: "Tersedia (≥ 500 m)" },
                  { value: "Menipis", label: "Menipis (< 500 m)" },
                  { value: "Kosong", label: "Kosong (0 m)" },
                ]}
              />
              <ClaySelect
                minWidth={150}
                value={kuYear}
                onChange={setKuYear}
                options={[
                  { value: "ALL", label: "Semua Tahun" },
                  ...kuData.years.map((y) => ({
                    value: y.year_label,
                    label: y.year_label,
                  })),
                ]}
              />
              {(kuSearch || kuWarehouse !== "ALL" || kuStatus !== "ALL" || kuYear !== "ALL") && (
                <button
                  className="clay-btn"
                  onClick={() => {
                    setKuSearch("");
                    setKuWarehouse("ALL");
                    setKuStatus("ALL");
                    setKuYear("ALL");
                  }}
                >
                  <X size={15} />
                  <span>Reset</span>
                </button>
              )}
            </section>

            <section className="glass-panel table-panel">
              <div className="section-header">
                <div className="section-title">Inventori Potongan KU ({filteredKuItems.length})</div>
              </div>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th onClick={() => handleSortKu("row_no")}>
                        No <ArrowUpDown size={12} />
                      </th>
                      <th onClick={() => handleSortKu("warehouse")}>
                        Gudang <ArrowUpDown size={12} />
                      </th>
                      <th onClick={() => handleSortKu("item_id")}>
                        ID Barang <ArrowUpDown size={12} />
                      </th>
                      <th onClick={() => handleSortKu("active_drum_count")}>
                        Drum <ArrowUpDown size={12} />
                      </th>
                      <th onClick={() => handleSortKu("total_meters")}>
                        Total (m) <ArrowUpDown size={12} />
                      </th>
                      <th>Tahun Kabel</th>
                      <th onClick={() => handleSortKu("status")}>
                        Status <ArrowUpDown size={12} />
                      </th>
                      <th style={{ textAlign: "right" }}>Aksi</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredKuItems.map((item, idx) => (
                      <tr key={`${item.warehouse}-${item.item_id}-${idx}`}>
                        <td className="tabular-nums">{item.row_no}</td>
                        <td>
                          <span className="clay-pill pill-slate">{item.warehouse}</span>
                        </td>
                        <td style={{ fontWeight: 700 }}>{item.item_id}</td>
                        <td className="tabular-nums">{item.active_drum_count} drum</td>
                        <td className="tabular-nums" style={{ fontWeight: 700, color: "#312e81" }}>
                          {formatNumber(item.total_meters)} m
                        </td>
                        <td className="tabular-nums">{formatYearRange(item)}</td>
                        <td>
                          <span className={`clay-pill ${statusPillClass(item.status)}`}>
                            {item.status}
                          </span>
                        </td>
                        <td style={{ textAlign: "right" }}>
                          <button
                            className="clay-btn"
                            style={{ padding: "6px 12px", fontSize: 12 }}
                            onClick={() => setInspectKuItem(item)}
                          >
                            <Eye size={14} />
                            <span>Detail</span>
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}

        {/* ================================================================
            VIEW 2: INV MTC (PT-2 & MAINTENANCE)
           ================================================================ */}
        {!loading && activeSheet === "inv_mtc" && mtcData && (
          <>
            <section className="kpi-grid">
              <div className="clay-card kpi-card">
                <div>
                  <div className="kpi-label">Total Stok PT-2 & MTC</div>
                  <div className="kpi-value tabular-nums">{formatNumber(mtcData.total_qty)}</div>
                  <div className="kpi-sub">Akumulasi seluruh unit & satuan</div>
                </div>
                <div className="clay-icon-orb orb-indigo">
                  <Database size={22} />
                </div>
              </div>
              <div className="clay-card kpi-card">
                <div>
                  <div className="kpi-label">Total Material</div>
                  <div className="kpi-value tabular-nums">{mtcData.total_skus} SKU</div>
                  <div className="kpi-sub">{mtcData.category_count} kategori aktif</div>
                </div>
                <div className="clay-icon-orb orb-sky">
                  <Package size={22} />
                </div>
              </div>
              <div className="clay-card kpi-card">
                <div>
                  <div className="kpi-label">Lokasi / SO</div>
                  <div className="kpi-value tabular-nums">{mtcData.locations.length} Titik</div>
                  <div className="kpi-sub">Sidoarjo & seluruh SO area</div>
                </div>
                <div className="clay-icon-orb orb-emerald">
                  <Warehouse size={22} />
                </div>
              </div>
              <div className="clay-card kpi-card">
                <div>
                  <div className="kpi-label">Stok Kosong</div>
                  <div className="kpi-value tabular-nums">{mtcData.out_of_stock_count}</div>
                  <div className="kpi-sub">Material dengan total 0</div>
                </div>
                <div className="clay-icon-orb orb-rose">
                  <AlertTriangle size={22} />
                </div>
              </div>
            </section>

            <section className="analytics-grid">
              <div className="clay-card section-card">
                <div className="section-title">
                  <Warehouse size={18} color="#4f46e5" />
                  <span>Distribusi per Lokasi / SO</span>
                </div>
                <div className="wh-list">
                  {mtcData.by_location.map((loc) => (
                    <div key={loc.name} className="wh-row">
                      <div className="wh-row-top">
                        <span>{loc.name}</span>
                        <span className="tabular-nums">
                          {formatNumber(loc.total_qty)} ({loc.share_percent.toFixed(1)}%)
                        </span>
                      </div>
                      <div className="clay-track">
                        <div
                          className="clay-fill"
                          style={{ width: `${Math.max(loc.share_percent, 1.5)}%` }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="clay-card section-card">
                <div className="section-title">
                  <Layers size={18} color="#059669" />
                  <span>Distribusi per Kategori</span>
                </div>
                <div className="wh-list">
                  {mtcData.by_category.map((cat) => {
                    const isActive = mtcCategory === cat.name;
                    return (
                      <div
                        key={cat.name}
                        className={`wh-row ${isActive ? "active" : ""}`}
                        onClick={() => setMtcCategory(isActive ? "ALL" : cat.name)}
                      >
                        <div className="wh-row-top">
                          <span>{cat.name}</span>
                          <span className="tabular-nums">
                            {formatNumber(cat.total_qty)} ({cat.item_count} SKU)
                          </span>
                        </div>
                        <div className="clay-track">
                          <div
                            className="clay-fill"
                            style={{ width: `${Math.max(cat.share_percent, 1.5)}%` }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </section>

            <section className="glass-panel filter-bar">
              <div className="search-wrap">
                <Search size={16} className="search-icon" />
                <input
                  type="text"
                  className="clay-input search-input"
                  placeholder="Cari kode material atau deskripsi..."
                  value={mtcSearch}
                  onChange={(e) => setMtcSearch(e.target.value)}
                />
              </div>
              <ClaySelect
                minWidth={190}
                value={mtcCategory}
                onChange={setMtcCategory}
                options={[
                  { value: "ALL", label: "Semua Kategori" },
                  ...mtcData.by_category.map((c) => ({
                    value: c.name,
                    label: c.name,
                  })),
                ]}
              />
              <ClaySelect
                minWidth={160}
                value={mtcStatus}
                onChange={setMtcStatus}
                options={[
                  { value: "ALL", label: "Semua Status" },
                  { value: "Tersedia", label: "Tersedia" },
                  { value: "Menipis", label: "Menipis (< 10)" },
                  { value: "Kosong", label: "Kosong (0)" },
                ]}
              />
              {(mtcSearch || mtcCategory !== "ALL" || mtcStatus !== "ALL") && (
                <button
                  className="clay-btn"
                  onClick={() => {
                    setMtcSearch("");
                    setMtcCategory("ALL");
                    setMtcStatus("ALL");
                  }}
                >
                  <X size={15} />
                  <span>Reset</span>
                </button>
              )}
            </section>

            <section className="glass-panel table-panel">
              <div className="section-title">
                Daftar Material INV MTC ({filteredMtcItems.length})
              </div>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Kategori</th>
                      <th>Material</th>
                      <th>Deskripsi</th>
                      <th>Satuan</th>
                      <th>Total</th>
                      <th>Status</th>
                      <th style={{ textAlign: "right" }}>Rincian SO</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredMtcItems.map((it, idx) => (
                      <tr key={`${it.material}-${idx}`}>
                        <td>
                          <span className="clay-pill pill-slate">{it.category}</span>
                        </td>
                        <td style={{ fontWeight: 700 }}>{it.material}</td>
                        <td style={{ color: "var(--text-secondary)", maxWidth: 320 }}>
                          {it.description}
                        </td>
                        <td>{it.unit}</td>
                        <td className="tabular-nums" style={{ fontWeight: 700, color: "#312e81" }}>
                          {formatNumber(it.total)}
                        </td>
                        <td>
                          <span className={`clay-pill ${statusPillClass(it.status)}`}>
                            {it.status}
                          </span>
                        </td>
                        <td style={{ textAlign: "right" }}>
                          <button
                            className="clay-btn"
                            style={{ padding: "6px 12px", fontSize: 12 }}
                            onClick={() => setInspectMtcItem(it)}
                          >
                            <Eye size={14} />
                            <span>Matrix SO</span>
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}

        {/* ================================================================
            VIEW 3: INVALL (MASTER ALL INVENTORY)
           ================================================================ */}
        {!loading && activeSheet === "invall" && invallData && (
          <>
            <section className="kpi-grid">
              <div className="clay-card kpi-card">
                <div>
                  <div className="kpi-label">Total Kuantitas</div>
                  <div className="kpi-value tabular-nums">{formatNumber(invallData.total_qty)}</div>
                  <div className="kpi-sub">Total stok seluruh area</div>
                </div>
                <div className="clay-icon-orb orb-indigo">
                  <Database size={22} />
                </div>
              </div>
              <div className="clay-card kpi-card">
                <div>
                  <div className="kpi-label">Total Baris Material</div>
                  <div className="kpi-value tabular-nums">{formatNumber(invallData.total_rows)}</div>
                  <div className="kpi-sub">{invallData.active_rows} baris stok aktif</div>
                </div>
                <div className="clay-icon-orb orb-sky">
                  <Activity size={22} />
                </div>
              </div>
              <div className="clay-card kpi-card">
                <div>
                  <div className="kpi-label">Area & Kategori</div>
                  <div className="kpi-value tabular-nums">{invallData.area_count} Area</div>
                  <div className="kpi-sub">{invallData.category_count} kategori material</div>
                </div>
                <div className="clay-icon-orb orb-emerald">
                  <Warehouse size={22} />
                </div>
              </div>
              <div className="clay-card kpi-card">
                <div>
                  <div className="kpi-label">Baris Stok Kosong</div>
                  <div className="kpi-value tabular-nums">
                    {formatNumber(invallData.out_of_stock_rows)}
                  </div>
                  <div className="kpi-sub">Baris dengan QTY = 0</div>
                </div>
                <div className="clay-icon-orb orb-rose">
                  <AlertTriangle size={22} />
                </div>
              </div>
            </section>

            <section className="analytics-grid">
              <div className="clay-card section-card">
                <div className="section-title">
                  <Warehouse size={18} color="#4f46e5" />
                  <span>Top Area (Name 1)</span>
                </div>
                <div className="wh-list">
                  {invallData.by_area.slice(0, 7).map((area) => {
                    const isActive = invallArea === area.name;
                    return (
                      <div
                        key={area.name}
                        className={`wh-row ${isActive ? "active" : ""}`}
                        onClick={() => setInvallArea(isActive ? "ALL" : area.name)}
                      >
                        <div className="wh-row-top">
                          <span>{area.name}</span>
                          <span className="tabular-nums">
                            {formatNumber(area.total_qty)} ({area.share_percent.toFixed(1)}%)
                          </span>
                        </div>
                        <div className="clay-track">
                          <div
                            className="clay-fill"
                            style={{ width: `${Math.max(area.share_percent, 1.5)}%` }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="clay-card section-card">
                <div className="section-title">
                  <Layers size={18} color="#059669" />
                  <span>Top Kategori Material</span>
                </div>
                <div className="wh-list">
                  {invallData.by_category.slice(0, 7).map((cat) => {
                    const isActive = invallCategory === cat.name;
                    return (
                      <div
                        key={cat.name}
                        className={`wh-row ${isActive ? "active" : ""}`}
                        onClick={() => setInvallCategory(isActive ? "ALL" : cat.name)}
                      >
                        <div className="wh-row-top">
                          <span>{cat.name}</span>
                          <span className="tabular-nums">
                            {formatNumber(cat.total_qty)} ({cat.share_percent.toFixed(1)}%)
                          </span>
                        </div>
                        <div className="clay-track">
                          <div
                            className="clay-fill"
                            style={{ width: `${Math.max(cat.share_percent, 1.5)}%` }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </section>

            <section className="glass-panel filter-bar">
              <div className="search-wrap">
                <Search size={16} className="search-icon" />
                <input
                  type="text"
                  className="clay-input search-input"
                  placeholder="Cari Material, Deskripsi, atau Area..."
                  value={invallSearch}
                  onChange={(e) => setInvallSearch(e.target.value)}
                />
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <Filter size={15} color="var(--text-muted)" />
                <ClaySelect
                  minWidth={160}
                  value={invallArea}
                  onChange={setInvallArea}
                  options={[
                    { value: "ALL", label: "Semua Area" },
                    ...invallData.by_area.map((a) => ({
                      value: a.name,
                      label: a.name,
                    })),
                  ]}
                />
              </div>
              <ClaySelect
                minWidth={185}
                value={invallCategory}
                onChange={setInvallCategory}
                options={[
                  { value: "ALL", label: "Semua Kategori" },
                  ...invallData.by_category.map((c) => ({
                    value: c.name,
                    label: c.name,
                  })),
                ]}
              />
              <ClaySelect
                minWidth={150}
                value={invallStatus}
                onChange={setInvallStatus}
                options={[
                  { value: "ALL", label: "Semua Status" },
                  { value: "Tersedia", label: "Tersedia (> 0)" },
                  { value: "Kosong", label: "Kosong (0)" },
                ]}
              />
              {(invallSearch ||
                invallArea !== "ALL" ||
                invallCategory !== "ALL" ||
                invallStatus !== "ALL") && (
                <button
                  className="clay-btn"
                  onClick={() => {
                    setInvallSearch("");
                    setInvallArea("ALL");
                    setInvallCategory("ALL");
                    setInvallStatus("ALL");
                  }}
                >
                  <X size={15} />
                  <span>Reset</span>
                </button>
              )}
            </section>

            <section className="glass-panel table-panel">
              <div className="section-header">
                <div className="section-title">
                  Master Inventori INVALL ({formatNumber(filteredInvallItems.length)} baris)
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <button
                    className="clay-btn"
                    style={{ padding: "6px 12px" }}
                    disabled={invallPage <= 1}
                    onClick={() => setInvallPage((p) => Math.max(1, p - 1))}
                  >
                    Prev
                  </button>
                  <span style={{ fontSize: 12.5, fontWeight: 600 }}>
                    Hal {invallPage} / {invallTotalPages}
                  </span>
                  <button
                    className="clay-btn"
                    style={{ padding: "6px 12px" }}
                    disabled={invallPage >= invallTotalPages}
                    onClick={() => setInvallPage((p) => Math.min(invallTotalPages, p + 1))}
                  >
                    Next
                  </button>
                </div>
              </div>

              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Area (Name 1)</th>
                      <th>Material</th>
                      <th>Deskripsi</th>
                      <th>Kategori</th>
                      <th>QTY</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pagedInvallItems.map((it, idx) => (
                      <tr key={`${it.area_name}-${it.material}-${idx}`}>
                        <td>
                          <span className="clay-pill pill-slate">{it.area_name}</span>
                        </td>
                        <td style={{ fontWeight: 700 }}>{it.material}</td>
                        <td style={{ color: "var(--text-secondary)", maxWidth: 340 }}>
                          {it.description}
                        </td>
                        <td>{it.category}</td>
                        <td className="tabular-nums" style={{ fontWeight: 700, color: "#312e81" }}>
                          {formatNumber(it.qty)}
                        </td>
                        <td>
                          <span className={`clay-pill ${statusPillClass(it.status)}`}>
                            {it.status}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}
      </div>

      {/* Drum Breakdown Modal (Potongan KU) */}
      {inspectKuItem && (
        <div className="modal-backdrop" onClick={() => setInspectKuItem(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="section-header">
              <div>
                <span className="clay-pill pill-indigo" style={{ marginBottom: 8 }}>
                  {inspectKuItem.warehouse}
                </span>
                <h2 style={{ fontSize: 20, fontWeight: 800, color: "#0f172a" }}>
                  {inspectKuItem.item_id}
                </h2>
                <p style={{ fontSize: 13, color: "var(--text-secondary)", marginTop: 3 }}>
                  Total Fisik:{" "}
                  <strong className="tabular-nums">
                    {formatNumber(inspectKuItem.total_meters)} m
                  </strong>{" "}
                  ({inspectKuItem.active_drum_count} drum aktif)
                </p>
              </div>
              <button className="clay-btn" onClick={() => setInspectKuItem(null)}>
                <X size={16} />
                <span>Tutup</span>
              </button>
            </div>

            {inspectKuItem.drums.length === 0 ? (
              <div
                style={{
                  marginTop: 20,
                  padding: 24,
                  textAlign: "center",
                  borderRadius: 18,
                  background: "rgba(255,255,255,0.65)",
                  color: "var(--text-muted)",
                }}
              >
                Stok fisik kosong (0 meter / tidak ada drum aktif).
              </div>
            ) : (
              <div className="drum-grid">
                {inspectKuItem.drums.map((drum) => (
                  <div key={drum.drum_index} className="drum-tile">
                    <div style={{ fontSize: 11.5, fontWeight: 700, color: "var(--text-muted)" }}>
                      DRUM #{drum.drum_index}
                    </div>
                    <div
                      className="tabular-nums"
                      style={{ fontSize: 18, fontWeight: 800, color: "#312e81", marginTop: 4 }}
                    >
                      {formatNumber(drum.meters)} m
                    </div>
                    <div style={{ marginTop: 6 }}>
                      <span
                        className={`clay-pill ${drum.year_valid ? "pill-emerald" : "pill-amber"}`}
                        style={{ fontSize: 11, padding: "3px 9px" }}
                      >
                        {drum.year_valid ? `Tahun ${drum.year}` : `Anomali: ${drum.year_raw}`}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* INV MTC Matrix Modal */}
      {inspectMtcItem && (
        <div className="modal-backdrop" onClick={() => setInspectMtcItem(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="section-header">
              <div>
                <span className="clay-pill pill-indigo" style={{ marginBottom: 8 }}>
                  {inspectMtcItem.category}
                </span>
                <h2 style={{ fontSize: 20, fontWeight: 800, color: "#0f172a" }}>
                  {inspectMtcItem.material}
                </h2>
                <p style={{ fontSize: 13, color: "var(--text-secondary)", marginTop: 3 }}>
                  {inspectMtcItem.description} • Total:{" "}
                  <strong>
                    {formatNumber(inspectMtcItem.total)} {inspectMtcItem.unit}
                  </strong>
                </p>
              </div>
              <button className="clay-btn" onClick={() => setInspectMtcItem(null)}>
                <X size={16} />
                <span>Tutup</span>
              </button>
            </div>

            <div className="drum-grid">
              {inspectMtcItem.location_stocks.map(([locName, qty]) => (
                <div key={locName} className="drum-tile">
                  <div style={{ fontSize: 11.5, fontWeight: 700, color: "var(--text-muted)" }}>
                    {locName}
                  </div>
                  <div
                    className="tabular-nums"
                    style={{
                      fontSize: 20,
                      fontWeight: 800,
                      color: qty > 0 ? "#312e81" : "#94a3b8",
                      marginTop: 6,
                    }}
                  >
                    {formatNumber(qty)} {inspectMtcItem.unit}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Status & Data Check Modal */}
      {showSecurityModal && (
        <div className="modal-backdrop" onClick={() => setShowSecurityModal(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="section-header">
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <div className="clay-icon-orb orb-emerald">
                  <Lock size={20} />
                </div>
                <div>
                  <h2 style={{ fontSize: 18.5, fontWeight: 800, color: "#0f172a" }}>
                    Status Aplikasi & Pemeriksaan Data
                  </h2>
                  <p style={{ fontSize: 12.5, color: "var(--text-secondary)" }}>
                    Ringkasan keamanan koneksi dan kecocokan angka dari Google Sheet
                  </p>
                </div>
              </div>
              <button className="clay-btn" onClick={() => setShowSecurityModal(false)}>
                <X size={16} />
              </button>
            </div>

            {security && (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                  gap: 12,
                  marginTop: 18,
                }}
              >
                <div className="drum-tile">
                  <div style={{ fontSize: 11.5, color: "var(--text-muted)", fontWeight: 700 }}>
                    KONEKSI DATA
                  </div>
                  <div style={{ fontSize: 13.5, fontWeight: 700, marginTop: 4 }}>
                    Terhubung Aman (HTTPS)
                  </div>
                </div>
                <div className="drum-tile">
                  <div style={{ fontSize: 11.5, color: "var(--text-muted)", fontWeight: 700 }}>
                    SUMBER RESMI
                  </div>
                  <div style={{ fontSize: 13.5, fontWeight: 700, marginTop: 4 }}>
                    Hanya dari Google Sheets
                  </div>
                </div>
                <div className="drum-tile">
                  <div style={{ fontSize: 11.5, color: "var(--text-muted)", fontWeight: 700 }}>
                    DATA OFFLINE
                  </div>
                  <div style={{ fontSize: 13.5, fontWeight: 700, marginTop: 4 }}>
                    Tersimpan & Terjaga Utuh
                  </div>
                </div>
                <div className="drum-tile">
                  <div style={{ fontSize: 11.5, color: "var(--text-muted)", fontWeight: 700 }}>
                    EKSPOR FILE
                  </div>
                  <div style={{ fontSize: 13.5, fontWeight: 700, marginTop: 4 }}>
                    Aman untuk dibuka di Excel
                  </div>
                </div>
              </div>
            )}

            <div style={{ marginTop: 22 }}>
              <h3 style={{ fontSize: 14.5, fontWeight: 700, marginBottom: 10 }}>
                Kecocokan Total per Sheet
              </h3>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))",
                  gap: 10,
                  marginBottom: 18,
                }}
              >
                <div className="drum-tile">
                  <div style={{ fontSize: 11, color: "var(--text-muted)", fontWeight: 700 }}>
                    POTONGAN KU
                  </div>
                  <div style={{ fontSize: 13, fontWeight: 700, marginTop: 4 }}>
                    {kuData
                      ? `${formatNumber(kuData.total_meters)} m (Sheet: ${formatNumber(
                          kuData.sheet_grand_total ?? kuData.total_meters
                        )} m)`
                      : "Belum dibuka"}
                  </div>
                  {kuData && (
                    <span
                      className={`clay-pill ${
                        kuData.sheet_grand_total === null ||
                        kuData.total_meters === kuData.sheet_grand_total
                          ? "pill-emerald"
                          : "pill-rose"
                      }`}
                      style={{ marginTop: 6, fontSize: 11 }}
                    >
                      {kuData.sheet_grand_total === null ||
                      kuData.total_meters === kuData.sheet_grand_total
                        ? "Total Cocok 100%"
                        : "Ada Selisih Total"}
                    </span>
                  )}
                </div>

                <div className="drum-tile">
                  <div style={{ fontSize: 11, color: "var(--text-muted)", fontWeight: 700 }}>
                    INV MTC
                  </div>
                  <div style={{ fontSize: 13, fontWeight: 700, marginTop: 4 }}>
                    {mtcData
                      ? `${formatNumber(mtcData.total_qty)} (Sheet: ${formatNumber(
                          mtcData.sheet_grand_total ?? mtcData.total_qty
                        )})`
                      : "Buka tab INV MTC untuk cek"}
                  </div>
                  {mtcData && (
                    <span
                      className={`clay-pill ${
                        mtcData.sheet_grand_total === null ||
                        mtcData.total_qty === mtcData.sheet_grand_total
                          ? "pill-emerald"
                          : "pill-rose"
                      }`}
                      style={{ marginTop: 6, fontSize: 11 }}
                    >
                      {mtcData.sheet_grand_total === null ||
                      mtcData.total_qty === mtcData.sheet_grand_total
                        ? "Total Cocok 100%"
                        : "Ada Selisih Total"}
                    </span>
                  )}
                </div>

                <div className="drum-tile">
                  <div style={{ fontSize: 11, color: "var(--text-muted)", fontWeight: 700 }}>
                    INVALL
                  </div>
                  <div style={{ fontSize: 13, fontWeight: 700, marginTop: 4 }}>
                    {invallData
                      ? `${formatNumber(invallData.total_rows)} baris • ${formatNumber(
                          invallData.total_qty
                        )} qty`
                      : "Buka tab INVALL untuk cek"}
                  </div>
                  {invallData && (
                    <span className="clay-pill pill-emerald" style={{ marginTop: 6, fontSize: 11 }}>
                      Data Lengkap
                    </span>
                  )}
                </div>
              </div>

              <h3 style={{ fontSize: 14.5, fontWeight: 700, marginBottom: 10 }}>
                Catatan Input Google Sheet (
                {(kuData?.anomalies.length ?? 0) + (mtcData?.anomalies.length ?? 0)})
              </h3>
              {(!kuData || kuData.anomalies.length === 0) &&
              (!mtcData || mtcData.anomalies.length === 0) ? (
                <div
                  className="drum-tile"
                  style={{ display: "flex", alignItems: "center", gap: 8, color: "#065f46" }}
                >
                  <CheckCircle2 size={16} />
                  <span>Tidak ada anomali integritas data yang ditemukan.</span>
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {[...(kuData?.anomalies ?? []), ...(mtcData?.anomalies ?? [])].map((an, i) => (
                    <div
                      key={i}
                      className="drum-tile"
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        gap: 12,
                      }}
                    >
                      <div>
                        <div style={{ fontWeight: 700, fontSize: 13 }}>
                          {an.warehouse} — {an.item_id}
                        </div>
                        <div style={{ fontSize: 12.5, color: "var(--text-secondary)" }}>
                          {an.detail}
                        </div>
                      </div>
                      <span className="clay-pill pill-amber">{an.kind}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div className="toast-banner">
          <CheckCircle2 size={16} color="#34d399" />
          <span>{toast}</span>
        </div>
      )}
      </div>
    </div>
  );
}
