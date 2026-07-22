use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

const HISTORY_SCHEMA_VERSION: u8 = 1;
const MAX_SAMPLES: usize = 32;
const MAX_SCAN_ENTRIES: u64 = 250_000;
const MAX_SCAN_ERRORS: u32 = 100;
const SAMPLE_INTERVAL_MS: u64 = 60 * 60 * 1_000;
const DAY_MS: u64 = 24 * 60 * 60 * 1_000;
const MIB: u64 = 1024 * 1024;
const GIB: u64 = 1024 * MIB;
const ADVISORY_TOTAL_BYTES: u64 = 768 * MIB;
const ADVISORY_DISPOSABLE_BYTES: u64 = 512 * MIB;
const ADVISORY_GROWTH_BYTES: i64 = 256 * MIB as i64;
const ACTION_TOTAL_BYTES: u64 = 1536 * MIB;
const ACTION_DISPOSABLE_BYTES: u64 = GIB;
const CRITICAL_TOTAL_BYTES: u64 = 3 * GIB;
const CRITICAL_LOW_DISK_BYTES: u64 = 2 * GIB;

static SCAN_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum StorageClass {
    Disposable,
    Persistent,
    Runtime,
    Diagnostics,
    Unknown,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "camelCase")]
pub enum StorageLevel {
    Healthy,
    Advisory,
    ActionRecommended,
    Critical,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageCategory {
    pub name: String,
    pub class: StorageClass,
    pub bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebviewStorageReport {
    pub supported: bool,
    pub platform: String,
    pub runtime: String,
    pub profile_path: String,
    pub app_version: String,
    pub scanned_at_ms: Option<u64>,
    pub last_full_scan_at_ms: Option<u64>,
    pub full_scan: bool,
    pub estimated: bool,
    pub total_bytes: u64,
    pub disposable_bytes: u64,
    pub persistent_bytes: u64,
    pub runtime_bytes: u64,
    pub diagnostic_bytes: u64,
    pub unknown_bytes: u64,
    pub free_disk_bytes: Option<u64>,
    pub growth_24h_bytes: Option<i64>,
    pub level: StorageLevel,
    pub categories: Vec<StorageCategory>,
    pub scan_duration_ms: u64,
    pub entries_scanned: u64,
    pub error_count: u32,
    pub incomplete: bool,
    pub sample_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StorageSample {
    timestamp_ms: u64,
    app_version: String,
    platform: String,
    runtime: String,
    total_bytes: u64,
    disposable_bytes: u64,
    persistent_bytes: u64,
    unknown_bytes: u64,
    level: StorageLevel,
    largest_categories: Vec<StorageCategory>,
    scan_duration_ms: u64,
    incomplete: bool,
    error_count: u32,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StorageHistory {
    schema_version: u8,
    samples: Vec<StorageSample>,
    latest_report: Option<WebviewStorageReport>,
    latest_full_report: Option<WebviewStorageReport>,
}

impl Default for StorageHistory {
    fn default() -> Self {
        Self {
            schema_version: HISTORY_SCHEMA_VERSION,
            samples: Vec::new(),
            latest_report: None,
            latest_full_report: None,
        }
    }
}

#[derive(Default)]
struct ScanTotals {
    bytes: u64,
    entries: u64,
    errors: u32,
    incomplete: bool,
}

pub fn history_path(app_config_dir: &Path) -> PathBuf {
    app_config_dir.join("webview-storage.json")
}

pub fn profile_path(app_local_data_dir: &Path) -> Option<PathBuf> {
    #[cfg(windows)]
    {
        Some(app_local_data_dir.join("EBWebView"))
    }
    #[cfg(not(windows))]
    {
        let _ = app_local_data_dir;
        None
    }
}

pub fn load_status(
    profile: Option<&Path>,
    history_file: &Path,
    app_version: &str,
) -> Result<WebviewStorageReport, String> {
    let history = load_history(history_file)?;
    if let Some(mut report) = history.latest_report {
        report.sample_count = history.samples.len();
        return Ok(report);
    }
    Ok(empty_report(profile, app_version))
}

pub fn scan(
    profile: Option<&Path>,
    history_file: &Path,
    app_version: &str,
    request_full_scan: bool,
) -> Result<WebviewStorageReport, String> {
    let _guard = SCAN_LOCK
        .lock()
        .map_err(|_| "The WebView storage scan lock is unavailable.".to_string())?;
    let Some(profile) = profile else {
        return Ok(empty_report(None, app_version));
    };
    let started = Instant::now();
    let now = epoch_milliseconds();
    let mut history = load_history(history_file)?;
    let full_scan = request_full_scan || history.latest_full_report.is_none();
    let category_roots = discover_categories(profile)?;
    let selected = category_roots
        .into_iter()
        .filter(|(_, _, class)| full_scan || *class == StorageClass::Disposable)
        .collect::<Vec<_>>();

    let mut scanned_categories = Vec::new();
    let mut entries_scanned: u64 = 0;
    let mut error_count: u32 = 0;
    let mut incomplete = false;
    for (name, path, class) in selected {
        let remaining_entries = MAX_SCAN_ENTRIES.saturating_sub(entries_scanned);
        if remaining_entries == 0 {
            incomplete = true;
            break;
        }
        let totals = scan_tree(&path, remaining_entries);
        entries_scanned += totals.entries;
        error_count = error_count.saturating_add(totals.errors);
        incomplete |= totals.incomplete;
        scanned_categories.push(StorageCategory {
            name,
            class,
            bytes: totals.bytes,
        });
        if error_count >= MAX_SCAN_ERRORS {
            incomplete = true;
            break;
        }
    }

    let (mut categories, estimated) = if full_scan {
        (scanned_categories, false)
    } else {
        let mut retained = history
            .latest_full_report
            .as_ref()
            .map(|report| report.categories.clone())
            .unwrap_or_default()
            .into_iter()
            .filter(|category| category.class != StorageClass::Disposable)
            .collect::<Vec<_>>();
        retained.extend(scanned_categories);
        (retained, true)
    };
    categories.sort_by(|left, right| {
        right
            .bytes
            .cmp(&left.bytes)
            .then_with(|| left.name.cmp(&right.name))
    });

    let total_bytes = categories.iter().map(|category| category.bytes).sum();
    let class_bytes = |class| {
        categories
            .iter()
            .filter(|category| category.class == class)
            .map(|category| category.bytes)
            .sum()
    };
    let disposable_bytes = class_bytes(StorageClass::Disposable);
    let persistent_bytes = class_bytes(StorageClass::Persistent);
    let runtime_bytes = class_bytes(StorageClass::Runtime);
    let diagnostic_bytes = class_bytes(StorageClass::Diagnostics);
    let unknown_bytes = class_bytes(StorageClass::Unknown);
    let growth_24h_bytes = growth_since_24h(&history.samples, now, total_bytes);
    let free_disk_bytes = available_disk_space(profile);
    let level = storage_level(
        total_bytes,
        disposable_bytes,
        growth_24h_bytes,
        free_disk_bytes,
    );
    let last_full_scan_at_ms = if full_scan {
        Some(now)
    } else {
        history
            .latest_full_report
            .as_ref()
            .and_then(|report| report.scanned_at_ms)
    };
    let mut report = WebviewStorageReport {
        supported: true,
        platform: platform_name().to_string(),
        runtime: runtime_name().to_string(),
        profile_path: profile.to_string_lossy().to_string(),
        app_version: app_version.to_string(),
        scanned_at_ms: Some(now),
        last_full_scan_at_ms,
        full_scan,
        estimated,
        total_bytes,
        disposable_bytes,
        persistent_bytes,
        runtime_bytes,
        diagnostic_bytes,
        unknown_bytes,
        free_disk_bytes,
        growth_24h_bytes,
        level,
        categories,
        scan_duration_ms: started.elapsed().as_millis() as u64,
        entries_scanned,
        error_count,
        incomplete,
        sample_count: 0,
    };

    if should_record_sample(&history.samples, now, level) {
        history.samples.push(StorageSample {
            timestamp_ms: now,
            app_version: app_version.to_string(),
            platform: platform_name().to_string(),
            runtime: runtime_name().to_string(),
            total_bytes,
            disposable_bytes,
            persistent_bytes,
            unknown_bytes,
            level,
            largest_categories: report.categories.iter().take(8).cloned().collect(),
            scan_duration_ms: report.scan_duration_ms,
            incomplete,
            error_count,
        });
        if history.samples.len() > MAX_SAMPLES {
            history
                .samples
                .drain(0..history.samples.len() - MAX_SAMPLES);
        }
    }
    report.sample_count = history.samples.len();
    history.latest_report = Some(report.clone());
    if full_scan {
        history.latest_full_report = Some(report.clone());
    }
    save_history(history_file, &history)?;
    Ok(report)
}

fn empty_report(profile: Option<&Path>, app_version: &str) -> WebviewStorageReport {
    let supported = profile.is_some();
    WebviewStorageReport {
        supported,
        platform: platform_name().to_string(),
        runtime: runtime_name().to_string(),
        profile_path: profile
            .map(|path| path.to_string_lossy().to_string())
            .unwrap_or_default(),
        app_version: app_version.to_string(),
        scanned_at_ms: None,
        last_full_scan_at_ms: None,
        full_scan: false,
        estimated: false,
        total_bytes: 0,
        disposable_bytes: 0,
        persistent_bytes: 0,
        runtime_bytes: 0,
        diagnostic_bytes: 0,
        unknown_bytes: 0,
        free_disk_bytes: None,
        growth_24h_bytes: None,
        level: StorageLevel::Healthy,
        categories: Vec::new(),
        scan_duration_ms: 0,
        entries_scanned: 0,
        error_count: 0,
        incomplete: false,
        sample_count: 0,
    }
}

fn discover_categories(profile: &Path) -> Result<Vec<(String, PathBuf, StorageClass)>, String> {
    if !profile.exists() {
        return Ok(Vec::new());
    }
    let root_metadata = fs::symlink_metadata(profile)
        .map_err(|error| format!("Failed to inspect WebView profile: {error}"))?;
    if root_metadata.file_type().is_symlink() || !root_metadata.is_dir() {
        return Err("The WebView profile path is not a safe directory.".to_string());
    }
    let mut categories = Vec::new();
    let root_entries = fs::read_dir(profile)
        .map_err(|error| format!("Failed to read WebView profile: {error}"))?;
    for entry in root_entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let path = entry.path();
        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(_) => continue,
        };
        if file_type.is_symlink() {
            continue;
        }
        if name.eq_ignore_ascii_case("Default") && file_type.is_dir() {
            if let Ok(default_entries) = fs::read_dir(&path) {
                for default_entry in default_entries.flatten() {
                    let child_name = default_entry.file_name().to_string_lossy().to_string();
                    let child_path = default_entry.path();
                    if default_entry
                        .file_type()
                        .map(|kind| kind.is_symlink())
                        .unwrap_or(true)
                    {
                        continue;
                    }
                    let label = format!("Default/{child_name}");
                    categories.push((label.clone(), child_path, classify_category(&label)));
                }
            }
        } else {
            categories.push((name.clone(), path, classify_category(&name)));
        }
    }
    Ok(categories)
}

fn classify_category(name: &str) -> StorageClass {
    let normalized = name.to_ascii_lowercase().replace(['_', '-'], " ");
    if [
        "local storage",
        "indexeddb",
        "webstorage",
        "session storage",
        "cookies",
        "preferences",
        "shared dictionary",
        "service worker",
    ]
    .iter()
    .any(|candidate| normalized.contains(candidate))
    {
        return StorageClass::Persistent;
    }
    if normalized.contains("cache") {
        return StorageClass::Disposable;
    }
    if normalized.contains("crashpad") || normalized.contains("crash report") {
        return StorageClass::Diagnostics;
    }
    if [
        "widevine",
        "subresource filter",
        "hyphen data",
        "pki",
        "certificate",
        "trust protection",
        "origintrials",
        "origin trials",
        "safe browsing",
        "network",
    ]
    .iter()
    .any(|candidate| normalized.contains(candidate))
    {
        return StorageClass::Runtime;
    }
    StorageClass::Unknown
}

fn scan_tree(start: &Path, max_entries: u64) -> ScanTotals {
    let mut totals = ScanTotals::default();
    let mut stack = vec![start.to_path_buf()];
    while let Some(path) = stack.pop() {
        if totals.entries >= max_entries || totals.errors >= MAX_SCAN_ERRORS {
            totals.incomplete = true;
            break;
        }
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(_) => {
                totals.errors += 1;
                continue;
            }
        };
        totals.entries += 1;
        if metadata.file_type().is_symlink() {
            continue;
        }
        if metadata.is_file() {
            totals.bytes = totals.bytes.saturating_add(metadata.len());
            continue;
        }
        if !metadata.is_dir() {
            continue;
        }
        match fs::read_dir(&path) {
            Ok(entries) => stack.extend(entries.filter_map(Result::ok).map(|entry| entry.path())),
            Err(_) => totals.errors += 1,
        }
    }
    totals
}

fn storage_level(
    total_bytes: u64,
    disposable_bytes: u64,
    growth_24h_bytes: Option<i64>,
    free_disk_bytes: Option<u64>,
) -> StorageLevel {
    if total_bytes >= CRITICAL_TOTAL_BYTES
        || (free_disk_bytes.is_some_and(|bytes| bytes < CRITICAL_LOW_DISK_BYTES)
            && disposable_bytes >= ADVISORY_DISPOSABLE_BYTES)
    {
        StorageLevel::Critical
    } else if total_bytes >= ACTION_TOTAL_BYTES || disposable_bytes >= ACTION_DISPOSABLE_BYTES {
        StorageLevel::ActionRecommended
    } else if total_bytes >= ADVISORY_TOTAL_BYTES
        || disposable_bytes >= ADVISORY_DISPOSABLE_BYTES
        || growth_24h_bytes.is_some_and(|bytes| bytes >= ADVISORY_GROWTH_BYTES)
    {
        StorageLevel::Advisory
    } else {
        StorageLevel::Healthy
    }
}

fn growth_since_24h(samples: &[StorageSample], now: u64, total_bytes: u64) -> Option<i64> {
    let target = now.saturating_sub(DAY_MS);
    samples
        .iter()
        .filter(|sample| sample.timestamp_ms <= target)
        .max_by_key(|sample| sample.timestamp_ms)
        .map(|sample| total_bytes as i64 - sample.total_bytes as i64)
}

fn should_record_sample(samples: &[StorageSample], now: u64, level: StorageLevel) -> bool {
    let Some(last) = samples.last() else {
        return true;
    };
    last.level != level || now.saturating_sub(last.timestamp_ms) >= SAMPLE_INTERVAL_MS
}

fn load_history(path: &Path) -> Result<StorageHistory, String> {
    if !path.is_file() {
        return Ok(StorageHistory::default());
    }
    let bytes = fs::read(path)
        .map_err(|error| format!("Failed to read WebView storage history: {error}"))?;
    let Ok(history) = serde_json::from_slice::<StorageHistory>(&bytes) else {
        return Ok(StorageHistory::default());
    };
    if history.schema_version != HISTORY_SCHEMA_VERSION {
        return Ok(StorageHistory::default());
    }
    Ok(history)
}

fn save_history(path: &Path, history: &StorageHistory) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "WebView storage history has no parent.".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Failed to create WebView storage history directory: {error}"))?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)
        .map_err(|error| format!("Failed to stage WebView storage history: {error}"))?;
    serde_json::to_writer_pretty(&mut temporary, history)
        .map_err(|error| format!("Failed to serialize WebView storage history: {error}"))?;
    std::io::Write::write_all(&mut temporary, b"\n")
        .map_err(|error| format!("Failed to write WebView storage history: {error}"))?;
    temporary
        .persist(path)
        .map_err(|error| format!("Failed to replace WebView storage history: {}", error.error))?;
    Ok(())
}

fn epoch_milliseconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(windows)]
fn available_disk_space(path: &Path) -> Option<u64> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;

    let wide = path
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let mut available = 0_u64;
    let mut total = 0_u64;
    let mut free = 0_u64;
    let success =
        unsafe { GetDiskFreeSpaceExW(wide.as_ptr(), &mut available, &mut total, &mut free) };
    (success != 0).then_some(available)
}

#[cfg(not(windows))]
fn available_disk_space(_path: &Path) -> Option<u64> {
    None
}

fn platform_name() -> &'static str {
    if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    }
}

fn runtime_name() -> &'static str {
    if cfg!(windows) {
        "Microsoft Edge WebView2"
    } else if cfg!(target_os = "macos") {
        "WKWebView (not yet qualified)"
    } else {
        "WebKitGTK (not yet qualified)"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_sized(path: &Path, bytes: usize) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, vec![0_u8; bytes]).unwrap();
    }

    #[test]
    fn classifies_and_persists_a_profile_scan() {
        let temp = tempfile::tempdir().unwrap();
        let profile = temp.path().join("EBWebView");
        write_sized(&profile.join("Default/Cache/data"), 200);
        write_sized(&profile.join("Default/Code Cache/code"), 100);
        write_sized(&profile.join("Default/Local Storage/state"), 50);
        write_sized(&profile.join("WidevineCdm/runtime"), 25);
        let history = temp.path().join("history.json");

        let report = scan(Some(&profile), &history, "0.5.2", true).unwrap();
        assert_eq!(report.total_bytes, 375);
        assert_eq!(report.disposable_bytes, 300);
        assert_eq!(report.persistent_bytes, 50);
        assert_eq!(report.runtime_bytes, 25);
        assert!(report.full_scan);
        assert_eq!(report.sample_count, 1);

        let loaded = load_status(Some(&profile), &history, "0.5.2").unwrap();
        assert_eq!(loaded.total_bytes, 375);
        assert_eq!(loaded.sample_count, 1);
    }

    #[test]
    fn quick_scan_refreshes_disposable_data_without_losing_full_categories() {
        let temp = tempfile::tempdir().unwrap();
        let profile = temp.path().join("EBWebView");
        write_sized(&profile.join("Default/Cache/data"), 200);
        write_sized(&profile.join("Default/Local Storage/state"), 50);
        let history = temp.path().join("history.json");
        scan(Some(&profile), &history, "0.5.2", true).unwrap();

        write_sized(&profile.join("Default/Cache/more"), 125);
        let report = scan(Some(&profile), &history, "0.5.2", false).unwrap();
        assert!(!report.full_scan);
        assert!(report.estimated);
        assert_eq!(report.disposable_bytes, 325);
        assert_eq!(report.persistent_bytes, 50);
        assert_eq!(report.total_bytes, 375);
    }

    #[test]
    fn thresholds_prioritize_critical_and_action_states() {
        assert_eq!(storage_level(100, 100, None, None), StorageLevel::Healthy);
        assert_eq!(
            storage_level(ADVISORY_TOTAL_BYTES, 100, None, None),
            StorageLevel::Advisory
        );
        assert_eq!(
            storage_level(ACTION_TOTAL_BYTES, 100, None, None),
            StorageLevel::ActionRecommended
        );
        assert_eq!(
            storage_level(CRITICAL_TOTAL_BYTES, 100, None, None),
            StorageLevel::Critical
        );
        assert_eq!(
            storage_level(
                100,
                ADVISORY_DISPOSABLE_BYTES,
                None,
                Some(CRITICAL_LOW_DISK_BYTES - 1)
            ),
            StorageLevel::Critical,
        );
    }
}
