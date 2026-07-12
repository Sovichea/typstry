use futures_util::{SinkExt, StreamExt};
use serde_json::json;
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use tauri::{Emitter, Manager};
use tokio::net::TcpListener;
use tokio_tungstenite::{
    accept_hdr_async, connect_async,
    tungstenite::{
        client::IntoClientRequest,
        handshake::server::{Request as WsServerRequest, Response as WsServerResponse},
    },
};

mod examples;
mod font_store;
mod project_archive;
mod project_fonts;
mod render_prepare;
mod scaled_fonts;
mod segmentation;
mod toolchain;
use examples::prepare_examples_workspace;
use render_prepare::{
    map_generated_to_source, map_source_to_generated, prepare_render_file, prepare_render_project,
};
use segmentation::{
    analyze_language_ranges, complete_language_word, get_provider_capabilities,
    install_hunspell_dictionary, language_suggestions, list_hunspell_catalog,
    remove_hunspell_dictionary, ProviderCapabilities, SegmentationRegistry,
};
use toolchain::active_tinymist;

fn workspace_font_directories(start: &Path) -> Vec<std::path::PathBuf> {
    for ancestor in start.ancestors() {
        let root = ancestor.join(".typstella").join("fonts");
        let mut candidates = Vec::new();
        if workspace_has_bound_font_package(ancestor) && root.join("package").is_dir() {
            candidates.push(root.join("package"));
        }
        if root.join("generated").is_dir() {
            candidates.push(root.join("generated"));
        }
        if !candidates.is_empty() {
            return candidates;
        }
    }
    Vec::new()
}

fn apply_workspace_font_paths(command: &mut std::process::Command, start: &Path) {
    let paths = workspace_font_directories(start);
    if !paths.is_empty() {
        if let Ok(value) = std::env::join_paths(paths) {
            command.env("TYPST_FONT_PATHS", value);
        }
    }
}

fn has_packaged_workspace_fonts(start: &Path) -> bool {
    start.ancestors().any(workspace_has_bound_font_package)
}

fn workspace_has_bound_font_package(workspace: &Path) -> bool {
    std::fs::read(workspace.join(project_archive::PROJECT_MANIFEST_PATH))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<project_archive::ProjectManifest>(&bytes).ok())
        .is_some_and(|manifest| manifest.render_environment.fonts_packaged)
}

#[tauri::command]
fn list_system_fonts() -> font_store::SystemFontCatalog {
    font_store::list_system_fonts()
}

#[tauri::command]
async fn prepare_scaled_workspace_font(
    state: tauri::State<'_, LspState>,
    workspace_root_path: String,
    family: String,
    scale: f32,
) -> Result<scaled_fonts::ScaledFontResult, String> {
    stop_lsp_process(&state).await;
    scaled_fonts::prepare_scaled_workspace_font(Path::new(&workspace_root_path), &family, scale)
}

#[tauri::command]
async fn clear_scaled_workspace_fonts(
    state: tauri::State<'_, LspState>,
    workspace_root_path: String,
) -> Result<(), String> {
    stop_lsp_process(&state).await;
    scaled_fonts::clear_scaled_workspace_fonts(Path::new(&workspace_root_path))
}

#[tauri::command]
#[cfg(debug_assertions)]
fn open_devtools(window: tauri::WebviewWindow) {
    let _ = window.open_devtools();
}

#[tauri::command]
#[cfg(not(debug_assertions))]
fn open_devtools(_window: tauri::WebviewWindow) {}

#[tauri::command]
async fn install_unicode_font(font_id: String) -> Result<font_store::InstalledFont, String> {
    font_store::install_unicode_font(&font_id).await
}

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SettingsFilePayload {
    path: String,
    settings: Option<serde_json::Value>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectImportPreflight {
    manifest: project_archive::ProjectManifest,
    manifest_sha256: String,
    entry_count: usize,
    total_uncompressed_bytes: u64,
    suggested_folder_name: String,
    toolchain_state: toolchain::ProjectToolchainState,
    active_typst_version: Option<String>,
    active_tinymist_version: Option<String>,
}

fn settings_file_path(app_handle: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    app_handle
        .path()
        .app_config_dir()
        .map(|directory| directory.join("settings.json"))
        .map_err(|error| format!("Failed to resolve settings directory: {}", error))
}

#[tauri::command]
fn load_app_settings(app_handle: tauri::AppHandle) -> Result<SettingsFilePayload, String> {
    let path = settings_file_path(&app_handle)?;
    let settings = if path.exists() {
        let contents = std::fs::read_to_string(&path)
            .map_err(|error| format!("Failed to read settings.json: {}", error))?;
        Some(
            serde_json::from_str(&contents)
                .map_err(|error| format!("Invalid settings.json: {}", error))?,
        )
    } else {
        None
    };

    Ok(SettingsFilePayload {
        path: path.to_string_lossy().to_string(),
        settings,
    })
}

#[tauri::command]
fn save_app_settings(
    app_handle: tauri::AppHandle,
    settings: serde_json::Value,
) -> Result<String, String> {
    let path = settings_file_path(&app_handle)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create settings directory: {}", error))?;
    }
    let contents = serde_json::to_string_pretty(&settings)
        .map_err(|error| format!("Failed to serialize settings: {}", error))?;
    std::fs::write(&path, format!("{}\n", contents))
        .map_err(|error| format!("Failed to write settings.json: {}", error))?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
fn read_workspace_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("Failed to read file: {}", e))
}

#[tauri::command]
fn open_file_externally(path: String) -> Result<(), String> {
    let file_path = std::path::Path::new(&path);
    if !file_path.is_file() {
        return Err("The selected file does not exist or is not a file.".to_string());
    }

    open::that_detached(file_path).map_err(|error| format!("Failed to open file: {error}"))
}

#[tauri::command]
fn read_workspace_file_as_base64(path: String) -> Result<String, String> {
    use base64::Engine;
    let bytes = std::fs::read(&path).map_err(|e| format!("Failed to read file: {}", e))?;
    let ext = std::path::Path::new(&path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    let mime = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "bmp" => "image/bmp",
        "avif" => "image/avif",
        _ => "application/octet-stream",
    };
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:{};base64,{}", mime, b64))
}

#[tauri::command]
fn workspace_path_exists(path: String) -> bool {
    std::path::Path::new(&path).exists()
}

struct TempFileGuard {
    path: std::path::PathBuf,
}

impl Drop for TempFileGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

fn cleanup_dir_previews(dir: &std::path::Path) {
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
                if name != ".git"
                    && name != ".typstella"
                    && name != "node_modules"
                    && name != "target"
                {
                    cleanup_dir_previews(&path);
                }
            } else if path.is_file() {
                if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                    if name.starts_with('.')
                        && (name.contains("typstella-preview") || name.contains("typstella-check"))
                    {
                        let _ = std::fs::remove_file(path);
                    }
                }
            }
        }
    }
}

#[tauri::command]
fn cleanup_workspace_preview_files(workspace_root_path: String) -> Result<(), String> {
    let root = std::path::PathBuf::from(workspace_root_path);
    if !root.is_dir() {
        return Ok(());
    }
    cleanup_dir_previews(&root);
    Ok(())
}

#[tauri::command]
fn save_workspace_file(path: String, contents: String) -> Result<(), String> {
    std::fs::write(&path, contents).map_err(|e| format!("Failed to save file: {}", e))
}

#[tauri::command]
fn create_workspace_dir(path: String) -> Result<(), String> {
    std::fs::create_dir_all(&path).map_err(|e| format!("Failed to create dir: {}", e))
}

#[tauri::command]
fn rename_workspace_file(old_path: String, new_path: String) -> Result<(), String> {
    std::fs::rename(&old_path, &new_path).map_err(|e| format!("Failed to rename: {}", e))
}

#[tauri::command]
fn copy_workspace_file(source: String, dest: String) -> Result<(), String> {
    std::fs::copy(&source, &dest)
        .map(|_| ())
        .map_err(|e| format!("Failed to copy: {}", e))
}

use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, Mutex,
};
use std::time::Instant;
use tokio::sync::mpsc;

#[allow(dead_code)]
#[cfg(windows)]
fn disable_webview_context_menus(webview: tauri::webview::PlatformWebview) {
    unsafe {
        if let Ok(core_webview) = webview.controller().CoreWebView2() {
            if let Ok(settings) = core_webview.Settings() {
                let _ = settings.SetAreDefaultContextMenusEnabled(false);
            }
        }
    }
}

#[allow(dead_code)]
#[cfg(not(windows))]
fn disable_webview_context_menus(_webview: tauri::webview::PlatformWebview) {}

struct LspState {
    generation: AtomicU64,
    tx: Mutex<Option<mpsc::Sender<String>>>,
    process: Mutex<Option<tokio::process::Child>>,
}

#[derive(Default)]
struct PendingProjectImports {
    paths: Mutex<Vec<PathBuf>>,
}

#[derive(Default)]
struct ProjectImportOperations {
    cancellations: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

#[tauri::command]
fn cancel_typstella_project_import(
    state: tauri::State<'_, ProjectImportOperations>,
    operation_id: String,
) {
    if let Ok(operations) = state.cancellations.lock() {
        if let Some(cancelled) = operations.get(&operation_id) {
            cancelled.store(true, Ordering::Relaxed);
        }
    }
}

impl PendingProjectImports {
    fn from_process_args() -> Self {
        let pending = Self::default();
        for argument in std::env::args_os().skip(1) {
            pending.push(PathBuf::from(argument));
        }
        pending
    }

    fn push(&self, candidate: PathBuf) {
        if !candidate
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value.eq_ignore_ascii_case("typstella"))
        {
            return;
        }
        let path = dunce::canonicalize(&candidate).unwrap_or(candidate);
        if !path.is_file() {
            return;
        }
        let key = project_import_path_key(&path);
        if let Ok(mut paths) = self.paths.lock() {
            if !paths
                .iter()
                .any(|existing| project_import_path_key(existing) == key)
            {
                paths.push(path);
            }
        }
    }

    fn take(&self) -> Vec<String> {
        self.paths
            .lock()
            .map(|mut paths| {
                paths
                    .drain(..)
                    .map(|path| path.to_string_lossy().into_owned())
                    .collect()
            })
            .unwrap_or_default()
    }
}

fn project_import_path_key(path: &Path) -> String {
    let value = path.to_string_lossy().replace('\\', "/");
    if cfg!(windows) {
        value.to_lowercase()
    } else {
        value
    }
}

#[tauri::command]
fn take_pending_project_imports(state: tauri::State<'_, PendingProjectImports>) -> Vec<String> {
    state.take()
}

#[cfg(test)]
mod project_open_queue_tests {
    use super::PendingProjectImports;

    #[test]
    fn accepts_only_existing_typstella_files_and_deduplicates_canonical_paths() {
        let directory = tempfile::tempdir().unwrap();
        let archive = directory.path().join("គម្រោង test.typstella");
        let source = directory.path().join("main.typ");
        std::fs::write(&archive, b"archive").unwrap();
        std::fs::write(&source, b"source").unwrap();
        let queue = PendingProjectImports::default();
        queue.push(archive.clone());
        queue.push(directory.path().join(".").join("គម្រោង test.typstella"));
        queue.push(source);
        queue.push(directory.path().join("missing.typstella"));

        let paths = queue.take();
        assert_eq!(paths.len(), 1);
        assert!(paths[0].ends_with("គម្រោង test.typstella"));
        assert!(queue.take().is_empty());
    }
}

#[derive(Clone, Default)]
struct StartupTimings {
    entries: Arc<Mutex<Vec<StartupTimingEntry>>>,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct StartupTimingEntry {
    source: &'static str,
    label: String,
    ms: f64,
}

impl StartupTimings {
    fn record(&self, source: &'static str, label: impl Into<String>, start: Instant) {
        let elapsed = start.elapsed().as_secs_f64() * 1000.0;
        if let Ok(mut entries) = self.entries.lock() {
            entries.push(StartupTimingEntry {
                source,
                label: label.into(),
                ms: elapsed,
            });
        }
    }

    fn snapshot(&self) -> Vec<StartupTimingEntry> {
        self.entries
            .lock()
            .map(|entries| entries.clone())
            .unwrap_or_default()
    }
}

#[tauri::command]
fn get_startup_timings(state: tauri::State<'_, StartupTimings>) -> Vec<StartupTimingEntry> {
    state.snapshot()
}

#[tauri::command]
async fn finish_startup_initialization(
    app_handle: tauri::AppHandle,
    registry: tauri::State<'_, SegmentationRegistry>,
    timings: tauri::State<'_, StartupTimings>,
) -> Result<Vec<ProviderCapabilities>, String> {
    let data_dir = app_handle
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("Failed to locate app data directory: {error}"))?;
    let registry = registry.inner().clone();
    let timings = timings.inner().clone();
    tokio::task::spawn_blocking(move || {
        let total_start = Instant::now();

        let legacy_font_start = Instant::now();
        font_store::remove_legacy_font_cache(&data_dir);
        timings.record(
            "deferred startup",
            "remove legacy font cache",
            legacy_font_start,
        );

        let provider_reload_start = Instant::now();
        registry.reload_installed(&data_dir)?;
        timings.record(
            "deferred startup",
            "load language providers",
            provider_reload_start,
        );

        let font_install_start = Instant::now();
        if let Err(error) = font_store::ensure_base_fonts_installed() {
            eprintln!("Failed to install bundled fonts for the current user: {error}");
        }
        timings.record(
            "deferred startup",
            "ensure and register bundled fonts",
            font_install_start,
        );

        let capabilities = registry.provider_capabilities()?;
        timings.record(
            "deferred startup",
            "finish startup initialization",
            total_start,
        );
        Ok(capabilities)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
fn read_workspace_dir(path: String) -> Result<Vec<serde_json::Value>, String> {
    let mut entries = vec![];
    let dir = std::fs::read_dir(&path).map_err(|e| format!("Failed to read dir: {}", e))?;
    for entry in dir {
        if let Ok(entry) = entry {
            let file_name = entry.file_name().to_string_lossy().to_string();
            // Ignore hidden system/editor metadata and temporary build files
            if file_name == ".git"
                || file_name.contains("typstella-check")
                || file_name.contains("typstella-preview")
                || file_name.contains(".export.typ")
            {
                continue;
            }
            let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
            entries.push(json!({
                "name": file_name,
                "isDirectory": is_dir
            }));
        }
    }
    Ok(entries)
}

#[tauri::command]
fn move_to_trash(path: String) -> Result<(), String> {
    trash::delete(&path).map_err(|e| format!("Failed to move to trash: {}", e))
}

#[tauri::command]
fn reveal_in_explorer(path: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        std::process::Command::new("explorer")
            .arg("/select,")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to open explorer: {}", e))?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-R")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to open finder: {}", e))?;
    }
    #[cfg(target_os = "linux")]
    {
        if let Some(parent) = std::path::Path::new(&path).parent() {
            std::process::Command::new("xdg-open")
                .arg(parent)
                .spawn()
                .map_err(|e| format!("Failed to open file manager: {}", e))?;
        }
    }
    Ok(())
}

#[derive(serde::Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct PreviewTarget {
    root_path: Option<String>,
    main_path: Option<String>,
    imported: bool,
    standalone: bool,
    disabled: bool,
}

fn normalized_existing_path(path: &std::path::Path) -> std::path::PathBuf {
    // std::fs::canonicalize returns verbatim `\\?\` paths on Windows. Tinymist
    // compares source identities against ordinary file-URI paths, so keep the
    // canonical path while removing that platform-specific representation.
    dunce::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn local_typst_dependencies(contents: &str, parent: &std::path::Path) -> Vec<std::path::PathBuf> {
    let bytes = contents.as_bytes();
    let mut dependencies = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index..].starts_with(b"//") {
            index += 2;
            while index < bytes.len() && bytes[index] != b'\n' {
                index += 1;
            }
            continue;
        }
        if bytes[index..].starts_with(b"/*") {
            index += 2;
            let mut depth = 1usize;
            while index < bytes.len() && depth > 0 {
                if bytes[index..].starts_with(b"/*") {
                    depth += 1;
                    index += 2;
                } else if bytes[index..].starts_with(b"*/") {
                    depth -= 1;
                    index += 2;
                } else {
                    index += 1;
                }
            }
            continue;
        }
        if bytes[index] == b'`' {
            let fence_start = index;
            while index < bytes.len() && bytes[index] == b'`' {
                index += 1;
            }
            let fence_len = index - fence_start;
            while index < bytes.len() {
                if bytes[index] == b'`' {
                    let close_start = index;
                    while index < bytes.len() && bytes[index] == b'`' {
                        index += 1;
                    }
                    if index - close_start >= fence_len {
                        break;
                    }
                } else {
                    index += 1;
                }
            }
            continue;
        }
        if bytes[index] == b'"' {
            index += 1;
            let mut escaped = false;
            while index < bytes.len() {
                let byte = bytes[index];
                index += 1;
                if byte == b'"' && !escaped {
                    break;
                }
                escaped = byte == b'\\' && !escaped;
                if byte != b'\\' {
                    escaped = false;
                }
            }
            continue;
        }
        let command_len = if bytes[index..].starts_with(b"#import") {
            7
        } else if bytes[index..].starts_with(b"#include") {
            8
        } else {
            index += 1;
            continue;
        };
        index += command_len;
        while index < bytes.len() && bytes[index].is_ascii_whitespace() {
            index += 1;
        }
        if index >= bytes.len() || bytes[index] != b'"' {
            continue;
        }
        index += 1;
        let start = index;
        let mut escaped = false;
        while index < bytes.len() {
            let byte = bytes[index];
            if byte == b'"' && !escaped {
                let raw = &contents[start..index];
                if !raw.starts_with('@') && !raw.contains("://") {
                    let candidate = normalized_existing_path(&parent.join(raw));
                    if candidate.extension().and_then(|value| value.to_str()) == Some("typ") {
                        dependencies.push(candidate);
                    }
                }
                index += 1;
                break;
            }
            escaped = byte == b'\\' && !escaped;
            if byte != b'\\' {
                escaped = false;
            }
            index += 1;
        }
    }
    dependencies
}

fn collect_typst_files(root: &std::path::Path, files: &mut Vec<std::path::PathBuf>) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            let name = entry.file_name();
            if name != ".git" && name != "target" && name != "node_modules" && name != ".typstella"
            {
                collect_typst_files(&path, files);
            }
        } else if path.extension().and_then(|value| value.to_str()) == Some("typ") {
            let name = path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or_default();
            if !name.contains("typstella-preview") {
                files.push(normalized_existing_path(&path));
            }
        }
    }
}

fn allows_standalone_preview(contents: &str) -> bool {
    matches!(
        contents.trim_start_matches('\u{feff}').lines().next(),
        Some("// @standalone-preview" | "//@standalone-preview")
    )
}

fn resolve_preview_target(
    file_path: String,
    workspace_root_path: Option<String>,
    file_contents: Option<String>,
    pinned_main_path: Option<String>,
) -> Result<PreviewTarget, String> {
    use std::collections::{HashMap, VecDeque};

    let path = normalized_existing_path(&std::path::PathBuf::from(&file_path));
    if path.extension().and_then(|ext| ext.to_str()) != Some("typ") {
        return Ok(PreviewTarget {
            root_path: None,
            main_path: None,
            imported: false,
            standalone: false,
            disabled: false,
        });
    }

    let active_contents =
        file_contents.unwrap_or_else(|| std::fs::read_to_string(&path).unwrap_or_default());
    let workspace_root = workspace_root_path
        .map(std::path::PathBuf::from)
        .map(|root| normalized_existing_path(&root))
        .or_else(|| path.parent().map(std::path::Path::to_path_buf));
    let mut files = Vec::new();
    if let Some(root) = workspace_root.as_deref() {
        collect_typst_files(root, &mut files);
    }
    if !files.contains(&path) {
        files.push(path.clone());
    }

    let mut reverse: HashMap<std::path::PathBuf, Vec<std::path::PathBuf>> = HashMap::new();
    for source in files {
        let contents = if source == path {
            active_contents.as_str()
        } else {
            match std::fs::read_to_string(&source) {
                Ok(contents) => {
                    for dependency in local_typst_dependencies(
                        &contents,
                        source.parent().unwrap_or(std::path::Path::new("")),
                    ) {
                        reverse.entry(dependency).or_default().push(source.clone());
                    }
                    continue;
                }
                Err(_) => continue,
            }
        };
        for dependency in local_typst_dependencies(
            contents,
            source.parent().unwrap_or(std::path::Path::new("")),
        ) {
            reverse.entry(dependency).or_default().push(source.clone());
        }
    }

    let mut ancestors: HashMap<std::path::PathBuf, usize> = HashMap::new();
    let mut queue = VecDeque::from([(path.clone(), 0usize)]);
    while let Some((child, distance)) = queue.pop_front() {
        for parent in reverse.get(&child).into_iter().flatten() {
            if ancestors
                .get(parent)
                .is_none_or(|known| distance + 1 < *known)
            {
                ancestors.insert(parent.clone(), distance + 1);
                queue.push_back((parent.clone(), distance + 1));
            }
        }
    }
    let preferred = |candidate: &std::path::Path| {
        matches!(
            candidate
                .file_name()
                .and_then(|name| name.to_str())
                .map(str::to_ascii_lowercase)
                .as_deref(),
            Some("main.typ" | "index.typ" | "document.typ")
        )
    };
    let standalone_preview = allows_standalone_preview(&active_contents);

    let mut preview_disabled = false;
    let main_root = if let Some(ref pinned) = pinned_main_path {
        let pinned_buf = normalized_existing_path(&std::path::PathBuf::from(pinned));
        let is_pinned_active = pinned_buf == path;

        if is_pinned_active {
            None
        } else if ancestors.contains_key(&pinned_buf) {
            Some(pinned_buf)
        } else {
            if !standalone_preview {
                preview_disabled = true;
            }
            None
        }
    } else {
        ancestors
            .iter()
            .filter(|(candidate, _)| preferred(candidate))
            .max_by_key(|(_, distance)| *distance)
            .or_else(|| ancestors.iter().max_by_key(|(_, distance)| *distance))
            .map(|(candidate, _)| candidate.clone())
    };

    let imported = if pinned_main_path.is_some() {
        if let Some(ref pinned) = pinned_main_path {
            let pinned_buf = normalized_existing_path(&std::path::PathBuf::from(pinned));
            pinned_buf != path && ancestors.contains_key(&pinned_buf)
        } else {
            false
        }
    } else {
        !ancestors.is_empty()
    };

    let root = if imported && standalone_preview {
        path.clone()
    } else {
        main_root.clone().unwrap_or_else(|| path.clone())
    };

    Ok(PreviewTarget {
        root_path: Some(root.to_string_lossy().to_string()),
        main_path: main_root.map(|p| p.to_string_lossy().to_string()),
        imported,
        standalone: !imported || standalone_preview,
        disabled: preview_disabled,
    })
}

#[tauri::command]
fn resolve_preview_main(
    file_path: String,
    workspace_root_path: Option<String>,
    file_contents: Option<String>,
    pinned_main_path: Option<String>,
) -> Result<PreviewTarget, String> {
    resolve_preview_target(
        file_path,
        workspace_root_path,
        file_contents,
        pinned_main_path,
    )
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct TypstCheckDiagnostic {
    severity: String,
    message: String,
    line: Option<usize>,
    column: Option<usize>,
}

#[tauri::command]
async fn check_typst_document(
    app_handle: tauri::AppHandle,
    source_code: String,
    file_path: String,
) -> Result<Vec<TypstCheckDiagnostic>, String> {
    use tauri::Manager;

    let path = std::path::Path::new(&file_path);
    let parent = path.parent().unwrap_or(std::path::Path::new(""));
    let file_stem = path.file_stem().unwrap_or_default().to_string_lossy();

    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();

    let input_path = parent.join(format!(".{}.typstella-check-{}.typ", file_stem, nonce));
    let temp_dir = std::env::temp_dir();
    let output_path = temp_dir.join(format!(".{}.typstella-check-{}.svg", file_stem, nonce));

    let data_dir = app_handle
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("Failed to get data dir: {}", e))?;
    let tinymist_cmd = active_tinymist(&data_dir)
        .ok_or_else(|| "No managed Tinymist toolchain is installed.".to_string())?;

    std::fs::write(&input_path, source_code).map_err(|e| format!("Check write failed: {}", e))?;
    let _input_guard = TempFileGuard {
        path: input_path.clone(),
    };
    let _output_guard = TempFileGuard {
        path: output_path.clone(),
    };

    let mut command = std::process::Command::new(&tinymist_cmd);
    command.current_dir(parent);
    apply_workspace_font_paths(&mut command, parent);
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);

    command.arg("compile");
    if has_packaged_workspace_fonts(parent) {
        command.arg("--ignore-system-fonts");
    }
    let output = command
        .arg("--root")
        .arg(parent)
        .arg("--format")
        .arg("svg")
        .arg(&input_path)
        .arg(&output_path)
        .output()
        .map_err(|e| format!("Tinymist check failed to start: {}", e));

    let output = output?;
    let stderr = String::from_utf8_lossy(&output.stderr);
    Ok(parse_typst_check_diagnostics(&stderr))
}

fn parse_typst_check_diagnostics(stderr: &str) -> Vec<TypstCheckDiagnostic> {
    let mut diagnostics = Vec::new();

    for line in stderr.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        if let Some(diagnostic) = parse_short_typst_diagnostic(trimmed) {
            diagnostics.push(diagnostic);
        } else if trimmed.starts_with("error:") || trimmed.starts_with("warning:") {
            let (severity, message) = trimmed.split_once(':').unwrap_or(("error", trimmed));
            diagnostics.push(TypstCheckDiagnostic {
                severity: severity.to_string(),
                message: message.trim().to_string(),
                line: None,
                column: None,
            });
        }
    }

    diagnostics
}

fn parse_short_typst_diagnostic(line: &str) -> Option<TypstCheckDiagnostic> {
    let (location, severity, message) =
        if let Some((location, message)) = line.split_once(": error:") {
            (location, "error", message)
        } else if let Some((location, message)) = line.split_once(": warning:") {
            (location, "warning", message)
        } else if let Some((location, message)) = line.split_once(": info:") {
            (location, "info", message)
        } else {
            return None;
        };

    let mut location_parts = location.rsplitn(3, ':');
    let column_number = location_parts.next()?.parse::<usize>().ok()?;
    let line_number = location_parts.next()?.parse::<usize>().ok()?;

    Some(TypstCheckDiagnostic {
        severity: severity.to_string(),
        message: message.trim().to_string(),
        line: Some(line_number),
        column: Some(column_number),
    })
}

#[tauri::command]
async fn compile_typst_document(
    app_handle: tauri::AppHandle,
    source_code: String,
    file_path: String,
) -> Result<String, String> {
    use tauri::Manager;
    let path = std::path::Path::new(&file_path);
    let parent = path.parent().unwrap_or(std::path::Path::new(""));
    let file_stem = path.file_stem().unwrap_or_default().to_string_lossy();

    let input_path = parent.join(format!(".{}.export.typ", file_stem));
    let output_path = path.with_extension("pdf");

    let data_dir = app_handle
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("Failed to get data dir: {}", e))?;
    let tinymist_cmd = active_tinymist(&data_dir)
        .ok_or_else(|| "No managed Tinymist toolchain is installed.".to_string())?;

    let mut file = std::fs::File::create(&input_path).map_err(|e| format!("IO Failure: {}", e))?;
    std::io::Write::write_all(&mut file, source_code.as_bytes())
        .map_err(|e| format!("Buffer Flush Failure: {}", e))?;

    let mut command = std::process::Command::new(&tinymist_cmd);
    command.current_dir(parent);
    apply_workspace_font_paths(&mut command, parent);
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);

    command.arg("compile");
    if has_packaged_workspace_fonts(parent) {
        command.arg("--ignore-system-fonts");
    }
    let output =
        command
            .arg("--root")
            .arg(".")
            .arg(input_path.file_name().ok_or_else(|| {
                "Failed to construct the temporary Typst export path.".to_string()
            })?)
            .arg(
                output_path
                    .file_name()
                    .ok_or_else(|| "Failed to construct the PDF export path.".to_string())?,
            )
            .output()
            .map_err(|e| format!("Host binary execution blocked: {}", e))?;

    let _ = std::fs::remove_file(&input_path);

    if !output.status.success() {
        let stderr_string = String::from_utf8_lossy(&output.stderr).to_string();
        return Err(stderr_string);
    }

    Ok(output_path.to_string_lossy().to_string())
}

#[tauri::command]
#[allow(dead_code)]
async fn compile_typst_preview(
    _app_handle: tauri::AppHandle,
    source_code: String,
    file_path: String,
    preview_root_path: Option<String>,
) -> Result<Vec<String>, String> {
    let active_path = std::path::Path::new(&file_path);
    let preview_path = preview_root_path
        .as_deref()
        .map(std::path::Path::new)
        .unwrap_or(active_path);
    let path = preview_path;
    let preview_source = if preview_path == active_path {
        source_code
    } else {
        std::fs::read_to_string(preview_path)
            .map_err(|error| format!("Failed to read preview root: {}", error))?
    };
    let parent = path.parent().unwrap_or(std::path::Path::new(""));
    let file_stem = path.file_stem().unwrap_or_default().to_string_lossy();
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let prefix = format!(".{}.typstella-preview-{}-", file_stem, nonce);
    let input_path = parent.join(format!("{}.typ", prefix));

    let temp_dir = std::env::temp_dir();
    let output_pattern = temp_dir.join(format!("{}{{0p}}.svg", prefix));

    // Clean up previously generated preview files to prevent disk leak
    if let Ok(entries) = std::fs::read_dir(&temp_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() {
                if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                    if name.starts_with(&format!(".{}.typstella-preview-", file_stem))
                        && name.ends_with(".svg")
                    {
                        let _ = std::fs::remove_file(path);
                    }
                }
            }
        }
    }

    let typst_cmd = std::path::PathBuf::from("typst");

    std::fs::write(&input_path, preview_source)
        .map_err(|error| format!("Preview source write failed: {}", error))?;
    let _input_guard = TempFileGuard {
        path: input_path.clone(),
    };
    let mut command = std::process::Command::new(&typst_cmd);
    command.current_dir(parent);
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    let output =
        command
            .arg("compile")
            .arg("--root")
            .arg(".")
            .arg("--format")
            .arg("svg")
            .arg(input_path.file_name().ok_or_else(|| {
                "Failed to construct the temporary Typst preview path.".to_string()
            })?)
            .arg(&output_pattern)
            .output()
            .map_err(|error| format!("Tinymist preview failed to start: {}", error));
    let output = output?;

    let mut page_paths: Vec<_> = std::fs::read_dir(&temp_dir)
        .map_err(|error| format!("Failed to read compiled preview: {}", error))?
        .flatten()
        .map(|entry| entry.path())
        .filter(|candidate| {
            candidate
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with(&prefix) && name.ends_with(".svg"))
        })
        .collect();
    page_paths.sort();
    if !output.status.success() {
        for page in page_paths {
            let _ = std::fs::remove_file(page);
        }
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    if page_paths.is_empty() {
        return Err("Typst produced no SVG preview pages.".to_string());
    }

    Ok(page_paths
        .into_iter()
        .map(|path| path.to_string_lossy().to_string())
        .collect())
}

#[tauri::command]
#[allow(dead_code)]
async fn compile_typst_pdf_preview(
    _app_handle: tauri::AppHandle,
    source_code: String,
    file_path: String,
    preview_root_path: Option<String>,
) -> Result<String, String> {
    let active_path = std::path::Path::new(&file_path);
    let preview_path = preview_root_path
        .as_deref()
        .map(std::path::Path::new)
        .unwrap_or(active_path);
    let path = preview_path;
    let preview_source = if preview_path == active_path {
        source_code
    } else {
        std::fs::read_to_string(preview_path)
            .map_err(|error| format!("Failed to read preview root: {}", error))?
    };
    let parent = path.parent().unwrap_or(std::path::Path::new(""));
    let file_stem = path.file_stem().unwrap_or_default().to_string_lossy();
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let prefix = format!(".{}.typstella-preview-pdf-{}-", file_stem, nonce);
    let input_path = parent.join(format!("{}.typ", prefix));

    let temp_dir = std::env::temp_dir();
    let output_path = temp_dir.join(format!("{}.pdf", prefix));

    // Clean up previously generated PDF preview files to prevent disk leak
    if let Ok(entries) = std::fs::read_dir(&temp_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() {
                if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                    if name.starts_with(&format!(".{}.typstella-preview-pdf-", file_stem))
                        && name.ends_with(".pdf")
                    {
                        let _ = std::fs::remove_file(path);
                    }
                }
            }
        }
    }

    let typst_cmd = std::path::PathBuf::from("typst");

    std::fs::write(&input_path, preview_source)
        .map_err(|error| format!("Preview source write failed: {}", error))?;
    let _input_guard = TempFileGuard {
        path: input_path.clone(),
    };

    let mut command = std::process::Command::new(&typst_cmd);
    command.current_dir(parent);
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    let output = command
        .arg("compile")
        .arg("--root")
        .arg(".")
        .arg(
            input_path
                .file_name()
                .ok_or_else(|| "Failed to construct path".to_string())?,
        )
        .arg(&output_path)
        .output()
        .map_err(|error| format!("Typst compile failed: {}", error))?;

    if !output.status.success() {
        let _ = std::fs::remove_file(&output_path);
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    Ok(output_path.to_string_lossy().to_string())
}

#[cfg(test)]
mod preview_main_tests {
    use super::{cleanup_workspace_preview_files, resolve_preview_target};

    #[test]
    fn cleanup_only_removes_managed_preview_entries() {
        let workspace = tempfile::tempdir().expect("create workspace");
        let preview = workspace.path().join(".chapter.typ.typstella-preview.typ");
        let document = workspace.path().join("chapter.typ");
        std::fs::write(&preview, "preview").expect("write preview");
        std::fs::write(&document, "chapter").expect("write chapter");

        cleanup_workspace_preview_files(workspace.path().to_string_lossy().to_string())
            .expect("cleanup previews");

        assert!(!preview.exists());
        assert!(document.exists());
    }

    #[cfg(windows)]
    #[test]
    fn preview_root_uses_the_same_windows_path_form_as_lsp_documents() {
        let workspace = tempfile::tempdir().expect("create workspace");
        let main_path = workspace.path().join("main.typ");
        std::fs::write(&main_path, "Main document").expect("write main");

        let resolved = resolve_preview_target(
            main_path.to_string_lossy().to_string(),
            Some(workspace.path().to_string_lossy().to_string()),
            None,
            None,
        )
        .expect("resolve preview");

        let root = resolved.root_path.expect("preview root");
        assert!(!root.starts_with(r"\\?\"), "verbatim path leaked: {root}");
    }

    #[test]
    fn imported_file_uses_workspace_main() {
        let workspace = tempfile::tempdir().expect("create workspace");
        let main_path = workspace.path().join("main.typ");
        let chapter_path = workspace.path().join("chapter.typ");
        std::fs::write(&main_path, "#include \"chapter.typ\"").expect("write main");
        std::fs::write(&chapter_path, "Chapter document").expect("write chapter");

        let resolved = resolve_preview_target(
            chapter_path.to_string_lossy().to_string(),
            Some(workspace.path().to_string_lossy().to_string()),
            None,
            None,
        )
        .expect("resolve preview");

        assert_eq!(
            resolved.root_path.as_deref(),
            Some(
                super::normalized_existing_path(&main_path)
                    .to_string_lossy()
                    .as_ref()
            )
        );
        assert_eq!(
            resolved.main_path.as_deref(),
            Some(
                super::normalized_existing_path(&main_path)
                    .to_string_lossy()
                    .as_ref()
            )
        );
        assert!(resolved.imported);
        assert!(!resolved.standalone);
    }

    #[test]
    fn unrelated_file_previews_itself() {
        let workspace = tempfile::tempdir().expect("create workspace");
        let main_path = workspace.path().join("main.typ");
        let library_path = workspace.path().join("library.typ");
        std::fs::write(&main_path, "Main document").expect("write main");
        std::fs::write(&library_path, "#let helper = 1").expect("write library");

        let resolved = resolve_preview_target(
            library_path.to_string_lossy().to_string(),
            Some(workspace.path().to_string_lossy().to_string()),
            None,
            None,
        )
        .expect("resolve preview");

        assert_eq!(
            resolved.root_path.as_deref(),
            Some(
                super::normalized_existing_path(&library_path)
                    .to_string_lossy()
                    .as_ref()
            )
        );
        assert!(!resolved.imported);
        assert!(resolved.standalone);
    }

    #[test]
    fn top_directive_enables_standalone_import_preview() {
        let workspace = tempfile::tempdir().expect("create workspace");
        let main_path = workspace.path().join("main.typ");
        let draft_path = workspace.path().join("chapter.typ");
        std::fs::write(&main_path, "#import \"chapter.typ\"").expect("write main");
        std::fs::write(&draft_path, "Chapter").expect("write draft");

        let resolved = resolve_preview_target(
            draft_path.to_string_lossy().to_string(),
            Some(workspace.path().to_string_lossy().to_string()),
            Some("// @standalone-preview\nUnsaved chapter".to_string()),
            None,
        )
        .expect("resolve preview");

        assert!(resolved.imported);
        assert!(resolved.standalone);
        assert_eq!(
            resolved.root_path.as_deref(),
            Some(
                super::normalized_existing_path(&draft_path)
                    .to_string_lossy()
                    .as_ref()
            )
        );
        assert_eq!(
            resolved.main_path.as_deref(),
            Some(
                super::normalized_existing_path(&main_path)
                    .to_string_lossy()
                    .as_ref()
            )
        );
    }

    #[test]
    fn example_11_proves_main_and_standalone_preview_ownership() {
        let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("examples")
            .join("04-projects")
            .join("03-typstella-readme");
        let main = root.join("main.typ");
        let khmer = root.join("chapters").join("khmer-research.typ");
        let standalone = root.join("chapters").join("research-workflow.typ");

        let khmer_target = resolve_preview_target(
            khmer.to_string_lossy().to_string(),
            Some(root.to_string_lossy().to_string()),
            None,
            Some(main.to_string_lossy().to_string()),
        )
        .expect("resolve Khmer chapter");
        assert_eq!(
            khmer_target.root_path.as_deref(),
            Some(
                super::normalized_existing_path(&main)
                    .to_string_lossy()
                    .as_ref()
            )
        );
        assert!(khmer_target.imported);
        assert!(!khmer_target.standalone);

        let standalone_target = resolve_preview_target(
            standalone.to_string_lossy().to_string(),
            Some(root.to_string_lossy().to_string()),
            None,
            Some(main.to_string_lossy().to_string()),
        )
        .expect("resolve standalone chapter");
        assert_eq!(
            standalone_target.root_path.as_deref(),
            Some(
                super::normalized_existing_path(&standalone)
                    .to_string_lossy()
                    .as_ref()
            )
        );
        assert!(standalone_target.imported);
        assert!(standalone_target.standalone);
    }

    #[test]
    fn transitive_import_uses_top_level_main() {
        let workspace = tempfile::tempdir().expect("create workspace");
        let main_path = workspace.path().join("main.typ");
        let chapter_path = workspace.path().join("chapter.typ");
        let helper_path = workspace.path().join("helper.typ");
        std::fs::write(&main_path, "#include \"chapter.typ\"").expect("write main");
        std::fs::write(&chapter_path, "#import \"helper.typ\"").expect("write chapter");
        std::fs::write(&helper_path, "#let value = 1").expect("write helper");

        let resolved = resolve_preview_target(
            helper_path.to_string_lossy().to_string(),
            Some(workspace.path().to_string_lossy().to_string()),
            None,
            None,
        )
        .expect("resolve preview");

        assert_eq!(
            resolved.root_path.as_deref(),
            Some(
                super::normalized_existing_path(&main_path)
                    .to_string_lossy()
                    .as_ref()
            )
        );
    }

    #[test]
    fn commented_import_does_not_create_a_preview_parent() {
        let workspace = tempfile::tempdir().expect("create workspace");
        let main_path = workspace.path().join("main.typ");
        let chapter_path = workspace.path().join("chapter.typ");
        std::fs::write(&main_path, "// #include \"chapter.typ\"\nMain").expect("write main");
        std::fs::write(&chapter_path, "Chapter").expect("write chapter");

        let resolved = resolve_preview_target(
            chapter_path.to_string_lossy().to_string(),
            Some(workspace.path().to_string_lossy().to_string()),
            None,
            None,
        )
        .expect("resolve preview");

        assert!(!resolved.imported);
    }
}

#[tauri::command]
async fn ensure_toolchain(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, LspState>,
) -> Result<toolchain::ToolchainStatus, String> {
    stop_lsp_process(&state).await;
    let data_dir = app_handle
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("Failed to get data dir: {}", error))?;
    toolchain::ensure(&data_dir).await
}

#[tauri::command]
async fn get_toolchain_status(
    app_handle: tauri::AppHandle,
) -> Result<toolchain::ToolchainStatus, String> {
    let data_dir = app_handle
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("Failed to get data dir: {}", error))?;
    Ok(toolchain::status(&data_dir))
}

#[tauri::command]
async fn list_tinymist_releases() -> Result<Vec<toolchain::TinymistReleaseInfo>, String> {
    toolchain::tinymist_releases().await
}

async fn stop_lsp_process(state: &tauri::State<'_, LspState>) {
    state.generation.fetch_add(1, Ordering::SeqCst);
    *state.tx.lock().unwrap() = None;
    let existing_process = state.process.lock().unwrap().take();
    if let Some(mut child) = existing_process {
        let _ = child.kill().await;
    }
}

#[tauri::command]
async fn install_tinymist_toolchain(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, LspState>,
    version: String,
) -> Result<toolchain::ToolchainStatus, String> {
    stop_lsp_process(&state).await;
    let data_dir = app_handle
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("Failed to get data dir: {}", error))?;
    toolchain::install(&data_dir, &version).await
}

#[tauri::command]
async fn start_tinymist_lsp(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, LspState>,
    workspace_root_path: Option<String>,
) -> Result<(), String> {
    use tauri::Manager;

    let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
    *state.tx.lock().unwrap() = None;
    let existing_process = state.process.lock().unwrap().take();
    if let Some(mut child) = existing_process {
        let _ = child.kill().await;
    }

    let data_dir = app_handle
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("Failed to get data dir: {}", e))?;
    let tinymist_exe = active_tinymist(&data_dir)
        .ok_or_else(|| "No managed Tinymist toolchain is installed.".to_string())?;

    let mut command = tokio::process::Command::new(&tinymist_exe);
    let mut ignore_system_fonts = false;
    if let Some(workspace_root) = workspace_root_path {
        let workspace = Path::new(&workspace_root);
        let paths = workspace_font_directories(workspace);
        if !paths.is_empty() {
            let project_manifest = workspace.join(project_archive::PROJECT_MANIFEST_PATH);
            if project_manifest.is_file() {
                let manifest: project_archive::ProjectManifest = serde_json::from_slice(
                    &std::fs::read(&project_manifest)
                        .map_err(|e| format!("Failed to read imported project manifest: {e}"))?,
                )
                .map_err(|e| format!("Failed to parse imported project manifest: {e}"))?;
                if manifest.render_environment.fonts_packaged {
                    let font_manifest: project_fonts::FontPackageManifest = serde_json::from_value(
                        serde_json::json!({ "version": 1, "fonts": manifest.fonts }),
                    )
                    .map_err(|e| format!("Invalid imported font manifest: {e}"))?;
                    project_fonts::verify_package_files(workspace, &font_manifest)?;
                    ignore_system_fonts = true;
                }
            }
            if let Ok(value) = std::env::join_paths(paths) {
                command.env("TYPST_FONT_PATHS", value);
            }
        }
    }
    command.arg("lsp");
    if ignore_system_fonts {
        command.arg("--ignore-system-fonts");
    }
    command
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);

    #[cfg(windows)]
    {
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = command
        .spawn()
        .map_err(|e| format!("Failed to spawn LSP: {}", e))?;

    let mut stdout = child.stdout.take().unwrap();
    let mut stdin = child.stdin.take().unwrap();

    let (tx, mut rx) = mpsc::channel::<String>(32);
    *state.tx.lock().unwrap() = Some(tx);

    let app_clone = app_handle.clone();
    tokio::spawn(async move {
        let mut byte = [0u8; 1];
        let mut header = Vec::new();
        loop {
            header.clear();
            loop {
                if tokio::io::AsyncReadExt::read_exact(&mut stdout, &mut byte)
                    .await
                    .is_err()
                {
                    let current_generation = app_clone
                        .state::<LspState>()
                        .generation
                        .load(Ordering::SeqCst);
                    if current_generation == generation {
                        let _ = app_clone.emit("lsp-status", "stopped");
                    }
                    return;
                }
                header.push(byte[0]);
                if header.ends_with(b"\r\n\r\n") {
                    break;
                }
            }

            let header_str = String::from_utf8_lossy(&header);
            let mut content_length = 0;
            for line in header_str.split("\r\n") {
                if line.starts_with("Content-Length: ") {
                    content_length = line["Content-Length: ".len()..].trim().parse().unwrap_or(0);
                }
            }

            if content_length > 0 {
                let mut content = vec![0u8; content_length];
                if tokio::io::AsyncReadExt::read_exact(&mut stdout, &mut content)
                    .await
                    .is_err()
                {
                    let current_generation = app_clone
                        .state::<LspState>()
                        .generation
                        .load(Ordering::SeqCst);
                    if current_generation == generation {
                        let _ = app_clone.emit("lsp-status", "stopped");
                    }
                    return;
                }
                if let Ok(json_str) = String::from_utf8(content) {
                    #[cfg(debug_assertions)]
                    let _ = std::fs::OpenOptions::new()
                        .create(true)
                        .append(true)
                        .open(std::env::temp_dir().join("typstella_lsp_log.txt"))
                        .and_then(|mut f| {
                            std::io::Write::write_all(
                                &mut f,
                                format!("RX: {}\n", json_str).as_bytes(),
                            )
                        });

                    let _ = app_clone.emit("lsp-rx", json_str);
                }
            }
        }
    });

    let app_clone = app_handle.clone();
    tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            #[cfg(debug_assertions)]
            let _ = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(std::env::temp_dir().join("typstella_lsp_log.txt"))
                .and_then(|mut f| {
                    std::io::Write::write_all(&mut f, format!("TX: {}\n", msg).as_bytes())
                });

            let payload: String = format!("Content-Length: {}\r\n\r\n{}", msg.len(), msg);
            if tokio::io::AsyncWriteExt::write_all(&mut stdin, payload.as_bytes())
                .await
                .is_err()
            {
                let current_generation = app_clone
                    .state::<LspState>()
                    .generation
                    .load(Ordering::SeqCst);
                if current_generation == generation {
                    let _ = app_clone.emit("lsp-status", "stopped");
                }
                break;
            }
            let _ = tokio::io::AsyncWriteExt::flush(&mut stdin).await;
        }
    });

    *state.process.lock().unwrap() = Some(child);
    let _ = app_handle.emit("lsp-status", "running");

    Ok(())
}

#[tauri::command]
async fn send_lsp_message(
    message: String,
    state: tauri::State<'_, LspState>,
) -> Result<(), String> {
    let tx = state.tx.lock().unwrap().clone();
    let Some(tx) = tx else {
        return Err("Tinymist LSP is not running.".to_string());
    };
    tx.send(message)
        .await
        .map_err(|_| "Tinymist LSP message channel is closed.".to_string())
}

#[tauri::command]
async fn fetch_loopback_resource(url: String) -> Result<Vec<u8>, String> {
    let parsed = reqwest::Url::parse(&url).map_err(|error| format!("Invalid URL: {error}"))?;
    if parsed.scheme() != "http" {
        return Err("Only http loopback preview resources can be fetched.".to_string());
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| "Preview resource URL has no host.".to_string())?;
    if host != "127.0.0.1" && host != "localhost" && host != "::1" {
        return Err("Only loopback preview resources can be fetched.".to_string());
    }
    if parsed.port().is_none() {
        return Err("Preview resource URL must include a port.".to_string());
    }

    let response = reqwest::get(parsed)
        .await
        .map_err(|error| format!("Failed to fetch preview resource: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("Preview resource request failed with {status}."));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("Failed to read preview resource: {error}"))?;
    const MAX_PREVIEW_RESOURCE_BYTES: usize = 32 * 1024 * 1024;
    if bytes.len() > MAX_PREVIEW_RESOURCE_BYTES {
        return Err("Preview resource is too large.".to_string());
    }
    Ok(bytes.to_vec())
}

fn parse_loopback_url(url: &str, expected_scheme: &str) -> Result<reqwest::Url, String> {
    let parsed = reqwest::Url::parse(url).map_err(|error| format!("Invalid URL: {error}"))?;
    if parsed.scheme() != expected_scheme {
        return Err(format!(
            "Only {expected_scheme} loopback preview URLs are supported."
        ));
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| "Preview URL has no host.".to_string())?;
    if host != "127.0.0.1" && host != "localhost" && host != "::1" {
        return Err("Only loopback preview URLs are supported.".to_string());
    }
    if parsed.port().is_none() {
        return Err("Preview URL must include a port.".to_string());
    }
    Ok(parsed)
}

#[tauri::command]
async fn start_preview_ws_proxy(target_url: String) -> Result<String, String> {
    let target = parse_loopback_url(&target_url, "ws")?;
    let target_port = target
        .port()
        .ok_or_else(|| "Preview WebSocket URL must include a port.".to_string())?;
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|error| format!("Failed to bind preview WebSocket proxy: {error}"))?;
    let proxy_port = listener
        .local_addr()
        .map_err(|error| format!("Failed to read preview WebSocket proxy port: {error}"))?
        .port();
    let target_base = target.to_string();

    tauri::async_runtime::spawn(async move {
        loop {
            let Ok((stream, _addr)) = listener.accept().await else {
                break;
            };
            let target_base = target_base.clone();
            tauri::async_runtime::spawn(async move {
                let requested_path = std::sync::Arc::new(std::sync::Mutex::new(String::from("/")));
                let requested_path_for_callback = requested_path.clone();
                let client_ws = match accept_hdr_async(
                    stream,
                    move |request: &WsServerRequest, response: WsServerResponse| {
                        if let Some(path_and_query) = request.uri().path_and_query() {
                            if let Ok(mut target) = requested_path_for_callback.lock() {
                                *target = path_and_query.as_str().to_string();
                            }
                        }
                        Ok(response)
                    },
                )
                .await
                {
                    Ok(socket) => socket,
                    Err(error) => {
                        eprintln!("Preview WebSocket proxy client handshake failed: {error}");
                        return;
                    }
                };

                let path = requested_path
                    .lock()
                    .map(|value| value.clone())
                    .unwrap_or_else(|_| "/".to_string());
                let mut outbound = match reqwest::Url::parse(&target_base) {
                    Ok(url) => url,
                    Err(error) => {
                        eprintln!("Preview WebSocket proxy target URL invalid: {error}");
                        return;
                    }
                };
                outbound.set_path(path.split('?').next().unwrap_or("/"));
                outbound.set_query(path.split_once('?').map(|(_, query)| query));
                let outbound_url = outbound.to_string();
                let mut outbound_request = match outbound_url.clone().into_client_request() {
                    Ok(request) => request,
                    Err(error) => {
                        eprintln!("Preview WebSocket proxy request creation failed: {error}");
                        return;
                    }
                };
                let origin = format!("http://127.0.0.1:{target_port}");
                if let Ok(value) = origin.parse() {
                    outbound_request.headers_mut().insert("Origin", value);
                }

                let server_ws = match connect_async(outbound_request).await {
                    Ok((socket, _response)) => socket,
                    Err(error) => {
                        eprintln!("Preview WebSocket proxy upstream handshake failed: {error}");
                        return;
                    }
                };

                let (mut client_write, mut client_read) = client_ws.split();
                let (mut server_write, mut server_read) = server_ws.split();
                let client_to_server = async {
                    while let Some(message) = client_read.next().await {
                        server_write.send(message?).await?;
                    }
                    Ok::<(), tokio_tungstenite::tungstenite::Error>(())
                };
                let server_to_client = async {
                    while let Some(message) = server_read.next().await {
                        client_write.send(message?).await?;
                    }
                    Ok::<(), tokio_tungstenite::tungstenite::Error>(())
                };
                tokio::select! {
                    result = client_to_server => {
                        if let Err(error) = result {
                            eprintln!("Preview WebSocket proxy client-to-server failed: {error}");
                        }
                    }
                    result = server_to_client => {
                        if let Err(error) = result {
                            eprintln!("Preview WebSocket proxy server-to-client failed: {error}");
                        }
                    }
                }
            });
        }
    });

    Ok(format!("ws://127.0.0.1:{proxy_port}"))
}

#[tauri::command]
async fn export_source_zip(workspace_path: String, zip_path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        project_archive::export_source_zip(Path::new(&workspace_path), Path::new(&zip_path))
    })
    .await
    .map_err(|error| format!("Source ZIP export task failed: {error}"))?
}

#[tauri::command]
async fn export_typstella_project(
    app_handle: tauri::AppHandle,
    workspace_path: String,
    archive_path: String,
    main_file_path: String,
    declared_font_families: Vec<String>,
) -> Result<project_archive::ProjectManifest, String> {
    let data_dir = app_handle
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("Failed to get data dir: {error}"))?;
    let toolchain = toolchain::status(&data_dir);
    let typst_version = toolchain.typst_version.ok_or_else(|| {
        "Cannot export a version-bound project because no validated Typst toolchain is active."
            .to_string()
    })?;
    let tinymist_version = toolchain.tinymist_version.ok_or_else(|| {
        "Cannot export a version-bound project because no validated Tinymist toolchain is active."
            .to_string()
    })?;
    let tinymist_executable = active_tinymist(&data_dir).ok_or_else(|| {
        "Cannot package fonts because the selected Tinymist executable is unavailable.".to_string()
    })?;
    tauri::async_runtime::spawn_blocking(move || {
        let workspace = Path::new(&workspace_path);
        let main = Path::new(&main_file_path);
        let audit = tempfile::tempdir().map_err(|e| format!("Failed to stage font audit: {e}"))?;
        let baseline_pdf = audit.path().join("baseline.pdf");
        let generated = workspace.join(".typstella").join("fonts").join("generated");
        project_fonts::compile_for_audit(
            &tinymist_executable, workspace, main, &baseline_pdf,
            generated.is_dir().then_some(generated.as_path()), false,
        )?;
        let baseline_fonts = project_fonts::pdf_postscript_names(&baseline_pdf)?;
        let mut required_fonts = baseline_fonts.clone();
        required_fonts.extend(project_fonts::declared_family_faces(workspace, &declared_font_families)?);
        let font_package = project_fonts::build_package(workspace, &required_fonts)?;
        let package_dir = project_fonts::verify_package_files(workspace, &font_package)?;
        let hermetic_pdf = audit.path().join("hermetic.pdf");
        project_fonts::compile_for_audit(
            &tinymist_executable, workspace, main, &hermetic_pdf, Some(&package_dir), true,
        )?;
        let hermetic_fonts = project_fonts::pdf_postscript_names(&hermetic_pdf)?;
        if hermetic_fonts != baseline_fonts {
            return Err(format!(
                "Hermetic font verification selected different faces. Required: {:?}; packaged compile: {:?}.",
                baseline_fonts, hermetic_fonts
            ));
        }
        let packaged_fonts = serde_json::from_value::<Vec<project_archive::ProjectFont>>(
            serde_json::to_value(font_package.fonts).map_err(|e| e.to_string())?
        ).map_err(|e| format!("Failed to construct project font manifest: {e}"))?;
        project_archive::export_typstella_project(project_archive::ProjectExport {
            workspace_root: Path::new(&workspace_path),
            archive_path: Path::new(&archive_path),
            main_file_path: Path::new(&main_file_path),
            app_version: env!("CARGO_PKG_VERSION"),
            typst_version: &typst_version,
            tinymist_version: &tinymist_version,
            packaged_fonts: Some(packaged_fonts),
        })
    })
    .await
    .map_err(|error| format!("Typstella project export task failed: {error}"))?
}

#[tauri::command]
async fn inspect_typstella_project(
    app_handle: tauri::AppHandle,
    archive_path: String,
) -> Result<ProjectImportPreflight, String> {
    let data_dir = app_handle
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("Failed to get data dir: {error}"))?;
    tauri::async_runtime::spawn_blocking(move || {
        let inspection = project_archive::inspect_typstella_project(Path::new(&archive_path))?;
        let active = toolchain::status(&data_dir);
        let toolchain_state = toolchain::project_toolchain_state(
            &data_dir,
            &inspection.manifest.toolchain.tinymist_version,
            &inspection.manifest.toolchain.typst_version,
        );
        Ok(ProjectImportPreflight {
            manifest: inspection.manifest,
            manifest_sha256: inspection.manifest_sha256,
            entry_count: inspection.entry_count,
            total_uncompressed_bytes: inspection.total_uncompressed_bytes,
            suggested_folder_name: inspection.suggested_folder_name,
            toolchain_state,
            active_typst_version: active.typst_version,
            active_tinymist_version: active.tinymist_version,
        })
    })
    .await
    .map_err(|error| format!("Project inspection task failed: {error}"))?
}

#[tauri::command]
async fn import_typstella_project(
    app_handle: tauri::AppHandle,
    archive_path: String,
    destination_path: String,
    expected_manifest_sha256: String,
    allow_incompatible_toolchain: bool,
    operation_id: String,
    operations: tauri::State<'_, ProjectImportOperations>,
) -> Result<project_archive::ImportedProject, String> {
    let data_dir = app_handle
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("Failed to get data dir: {error}"))?;
    let cancelled = Arc::new(AtomicBool::new(false));
    operations
        .cancellations
        .lock()
        .map_err(|_| "Project import cancellation state is unavailable.".to_string())?
        .insert(operation_id.clone(), cancelled.clone());
    let result = tauri::async_runtime::spawn_blocking(move || {
        let inspection = project_archive::inspect_typstella_project(Path::new(&archive_path))?;
        let state = toolchain::project_toolchain_state(
            &data_dir,
            &inspection.manifest.toolchain.tinymist_version,
            &inspection.manifest.toolchain.typst_version,
        );
        if !allow_incompatible_toolchain
            && !matches!(state, toolchain::ProjectToolchainState::ExactActive)
        {
            return Err(
                "The compatible project toolchain is not active. Select or download it before importing."
                    .to_string(),
            );
        }
        project_archive::import_typstella_project_cancellable(
            Path::new(&archive_path),
            Path::new(&destination_path),
            &expected_manifest_sha256,
            || cancelled.load(Ordering::Relaxed),
        )
    })
    .await
    .map_err(|error| format!("Project import task failed: {error}"))?;
    if let Ok(mut active) = operations.cancellations.lock() {
        active.remove(&operation_id);
    }
    result
}

#[tauri::command]
async fn select_project_toolchain(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, LspState>,
    tinymist_version: String,
    typst_version: String,
) -> Result<toolchain::ToolchainStatus, String> {
    stop_lsp_process(&state).await;
    let data_dir = app_handle
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("Failed to get data dir: {error}"))?;
    tauri::async_runtime::spawn_blocking(move || {
        toolchain::select_project_toolchain(&data_dir, &tinymist_version, &typst_version)
    })
    .await
    .map_err(|error| format!("Toolchain selection task failed: {error}"))?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let native_start = Instant::now();
    let startup_timings = StartupTimings::default();
    let registry_start = Instant::now();
    let segmentation_registry = SegmentationRegistry::empty();
    startup_timings.record(
        "native startup",
        "create empty language registry",
        registry_start,
    );
    let setup_timings = startup_timings.clone();
    let pending_project_imports = PendingProjectImports::from_process_args();
    tauri::Builder::default()
        .manage(pending_project_imports)
        .manage(ProjectImportOperations::default())
        .plugin(tauri_plugin_single_instance::init(
            |app, arguments, _working_directory| {
                let pending = app.state::<PendingProjectImports>();
                for argument in arguments.into_iter().skip(1) {
                    pending.push(PathBuf::from(argument));
                }
                let _ = app.emit("typstella-project-open-requested", ());
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            },
        ))
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(LspState {
            generation: AtomicU64::new(0),
            tx: Mutex::new(None),
            process: Mutex::new(None),
        })
        .manage(startup_timings)
        .manage(segmentation_registry)
        .setup(move |app| {
            let setup_start = Instant::now();
            let examples_start = Instant::now();
            if let Err(error) = examples::install_examples_workspace(app.handle()) {
                eprintln!("Failed to install bundled examples: {error}");
            }
            setup_timings.record("native startup", "sync bundled examples", examples_start);
            #[cfg(not(debug_assertions))]
            let context_menu_start = Instant::now();
            #[cfg(not(debug_assertions))]
            if let Some(webview) = app.get_webview_window("main") {
                let _ = webview.with_webview(disable_webview_context_menus);
            }
            #[cfg(not(debug_assertions))]
            setup_timings.record(
                "native startup",
                "configure release webview",
                context_menu_start,
            );
            setup_timings.record("native startup", "tauri setup total", setup_start);
            setup_timings.record(
                "native startup",
                "native run until setup complete",
                native_start,
            );
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_startup_timings,
            finish_startup_initialization,
            load_app_settings,
            save_app_settings,
            compile_typst_document,
            check_typst_document,
            read_workspace_file,
            open_file_externally,
            read_workspace_file_as_base64,
            workspace_path_exists,
            cleanup_workspace_preview_files,
            export_source_zip,
            export_typstella_project,
            inspect_typstella_project,
            import_typstella_project,
            cancel_typstella_project_import,
            select_project_toolchain,
            take_pending_project_imports,
            save_workspace_file,
            create_workspace_dir,
            rename_workspace_file,
            copy_workspace_file,
            read_workspace_dir,
            move_to_trash,
            reveal_in_explorer,
            resolve_preview_main,
            ensure_toolchain,
            get_toolchain_status,
            list_system_fonts,
            prepare_scaled_workspace_font,
            clear_scaled_workspace_fonts,
            install_unicode_font,
            analyze_language_ranges,
            language_suggestions,
            get_provider_capabilities,
            list_hunspell_catalog,
            install_hunspell_dictionary,
            remove_hunspell_dictionary,
            open_devtools,
            complete_language_word,
            prepare_examples_workspace,
            list_tinymist_releases,
            install_tinymist_toolchain,
            start_tinymist_lsp,
            send_lsp_message,
            prepare_render_project,
            prepare_render_file,
            map_generated_to_source,
            map_source_to_generated,
            fetch_loopback_resource,
            start_preview_ws_proxy
        ])
        .run(tauri::generate_context!())
        .expect("Error initializing Tauri execution engine");
}
