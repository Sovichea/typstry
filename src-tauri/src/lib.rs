use serde_json::json;
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use tauri::{Emitter, Manager};

mod examples;
mod font_store;
mod segmentation;
mod toolchain;
mod render_prepare;
use examples::prepare_examples_workspace;
use segmentation::{
    analyze_language_ranges, complete_language_word, get_provider_capabilities,
    language_suggestions, SegmentationRegistry,
};
use toolchain::active_tinymist;
use render_prepare::{
    prepare_render_project,
    prepare_render_file,
    map_generated_to_source,
    map_source_to_generated,
};


#[tauri::command]
fn list_system_fonts() -> font_store::SystemFontCatalog {
    font_store::list_system_fonts()
}

#[tauri::command]
fn open_devtools(window: tauri::WebviewWindow) {
    let _ = window.open_devtools();
}

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
fn workspace_path_exists(path: String) -> bool {
    std::path::Path::new(&path).exists()
}

#[tauri::command]
fn cleanup_workspace_preview_files(workspace_root_path: String) -> Result<(), String> {
    let root = std::path::PathBuf::from(workspace_root_path);
    if !root.is_dir() {
        return Ok(());
    }
    for entry in std::fs::read_dir(&root)
        .map_err(|error| format!("Failed to inspect workspace preview files: {error}"))?
        .flatten()
    {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if path.is_file() && name.starts_with('.') && name.ends_with(".typstry-preview.typ") {
            let _ = std::fs::remove_file(path);
        }
    }
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

use std::sync::{
    atomic::{AtomicU64, Ordering},
    Mutex,
};
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

#[tauri::command]
fn read_workspace_dir(path: String) -> Result<Vec<serde_json::Value>, String> {
    let mut entries = vec![];
    let dir = std::fs::read_dir(&path).map_err(|e| format!("Failed to read dir: {}", e))?;
    for entry in dir {
        if let Ok(entry) = entry {
            let file_name = entry.file_name().to_string_lossy().to_string();
            // Ignore hidden system/editor metadata and temporary build files
            if file_name == ".git"
                || file_name.contains("typstry-check")
                || file_name.contains("typstry-preview")
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
    live_updates: bool,
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
            if name != ".git" && name != "target" && name != "node_modules" {
                collect_typst_files(&path, files);
            }
        } else if path.extension().and_then(|value| value.to_str()) == Some("typ") {
            let name = path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or_default();
            if !name.contains("typstry-preview") {
                files.push(normalized_existing_path(&path));
            }
        }
    }
}

fn allows_live_import_preview(contents: &str) -> bool {
    matches!(
        contents.trim_start_matches('\u{feff}').lines().next(),
        Some("// @allow-preview" | "//@allow-preview")
    )
}

fn resolve_preview_target(
    file_path: String,
    workspace_root_path: Option<String>,
    file_contents: Option<String>,
) -> Result<PreviewTarget, String> {
    use std::collections::{HashMap, VecDeque};

    let path = normalized_existing_path(&std::path::PathBuf::from(&file_path));
    if path.extension().and_then(|ext| ext.to_str()) != Some("typ") {
        return Ok(PreviewTarget {
            root_path: None,
            main_path: None,
            imported: false,
            live_updates: false,
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
    let imported = !ancestors.is_empty();
    let allow_preview = allows_live_import_preview(&active_contents);
    let main_root = ancestors
        .iter()
        .filter(|(candidate, _)| preferred(candidate))
        .max_by_key(|(_, distance)| *distance)
        .or_else(|| ancestors.iter().max_by_key(|(_, distance)| *distance))
        .map(|(candidate, _)| candidate.clone());

    let root = if imported && allow_preview {
        path.clone()
    } else {
        main_root.clone().unwrap_or_else(|| path.clone())
    };

    Ok(PreviewTarget {
        root_path: Some(root.to_string_lossy().to_string()),
        main_path: main_root.map(|p| p.to_string_lossy().to_string()),
        imported,
        live_updates: !imported || allow_preview,
    })
}

#[tauri::command]
fn resolve_preview_main(
    file_path: String,
    workspace_root_path: Option<String>,
    file_contents: Option<String>,
) -> Result<PreviewTarget, String> {
    resolve_preview_target(file_path, workspace_root_path, file_contents)
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

    let input_path = parent.join(format!(".{}.typstry-check-{}.typ", file_stem, nonce));
    let temp_dir = std::env::temp_dir();
    let output_path = temp_dir.join(format!(".{}.typstry-check-{}.svg", file_stem, nonce));

    let data_dir = app_handle
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("Failed to get data dir: {}", e))?;
    let tinymist_cmd = active_tinymist(&data_dir)
        .ok_or_else(|| "No managed Tinymist toolchain is installed.".to_string())?;

    std::fs::write(&input_path, source_code).map_err(|e| format!("Check write failed: {}", e))?;

    let mut command = std::process::Command::new(&tinymist_cmd);
    command.current_dir(parent);
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);

    let output = command
        .arg("compile")
        .arg("--root")
        .arg(parent)
        .arg("--format")
        .arg("svg")
        .arg(&input_path)
        .arg(&output_path)
        .output()
        .map_err(|e| format!("Tinymist check failed to start: {}", e));

    let _ = std::fs::remove_file(&input_path);
    let _ = std::fs::remove_file(&output_path);

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
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);

    let output =
        command
            .arg("compile")
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
async fn compile_typst_preview(
    app_handle: tauri::AppHandle,
    source_code: String,
    file_path: String,
    preview_root_path: Option<String>,
) -> Result<Vec<String>, String> {
    use tauri::Manager;
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
    let prefix = format!(".{}.typstry-preview-{}-", file_stem, nonce);
    let input_path = parent.join(format!("{}.typ", prefix));

    let temp_dir = std::env::temp_dir();
    let output_pattern = temp_dir.join(format!("{}{{0p}}.svg", prefix));

    let data_dir = app_handle
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("Failed to get data dir: {}", error))?;
    let tinymist_cmd = active_tinymist(&data_dir)
        .ok_or_else(|| "No managed Tinymist toolchain is installed.".to_string())?;

    std::fs::write(&input_path, preview_source)
        .map_err(|error| format!("Preview source write failed: {}", error))?;
    let mut command = std::process::Command::new(&tinymist_cmd);
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
    let _ = std::fs::remove_file(&input_path);
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

    let mut pages = Vec::with_capacity(page_paths.len());
    let mut read_error = None;
    for page in page_paths {
        match std::fs::read_to_string(&page) {
            Ok(contents) => pages.push(contents),
            Err(error) if read_error.is_none() => {
                read_error = Some(format!("Failed to read preview page: {}", error));
            }
            Err(_) => {}
        }
        let _ = std::fs::remove_file(page);
    }
    if let Some(error) = read_error {
        return Err(error);
    }
    if pages.is_empty() {
        return Err("Tinymist produced no SVG preview pages.".to_string());
    }
    Ok(pages)
}

#[cfg(test)]
mod preview_main_tests {
    use super::{cleanup_workspace_preview_files, resolve_preview_target};

    #[test]
    fn cleanup_only_removes_managed_preview_entries() {
        let workspace = tempfile::tempdir().expect("create workspace");
        let preview = workspace.path().join(".chapter.typ.typstry-preview.typ");
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
        assert!(!resolved.live_updates);
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
        assert!(resolved.live_updates);
    }

    #[test]
    fn top_directive_enables_live_import_preview() {
        let workspace = tempfile::tempdir().expect("create workspace");
        let main_path = workspace.path().join("main.typ");
        let draft_path = workspace.path().join("chapter.typ");
        std::fs::write(&main_path, "#import \"chapter.typ\"").expect("write main");
        std::fs::write(&draft_path, "Chapter").expect("write draft");

        let resolved = resolve_preview_target(
            draft_path.to_string_lossy().to_string(),
            Some(workspace.path().to_string_lossy().to_string()),
            Some("// @allow-preview\nUnsaved chapter".to_string()),
        )
        .expect("resolve preview");

        assert!(resolved.imported);
        assert!(resolved.live_updates);
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
    command
        .arg("lsp")
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
                        .open(std::env::temp_dir().join("typstry_lsp_log.txt"))
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
                .open(std::env::temp_dir().join("typstry_lsp_log.txt"))
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let segmentation_registry =
        SegmentationRegistry::new().expect("Failed to initialize language segmentation providers");
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(LspState {
            generation: AtomicU64::new(0),
            tx: Mutex::new(None),
            process: Mutex::new(None),
        })
        .manage(segmentation_registry)
        .setup(|app| {
            if let Err(error) = examples::install_examples_workspace(app.handle()) {
                eprintln!("Failed to install bundled examples: {error}");
            }
            if let Ok(data_dir) = app.path().app_local_data_dir() {
                font_store::remove_legacy_font_cache(&data_dir);
            }
            if let Err(error) = font_store::ensure_base_fonts_installed() {
                eprintln!("Failed to install bundled fonts for the current user: {error}");
            }
            #[cfg(not(debug_assertions))]
            if let Some(webview) = app.get_webview_window("main") {
                let _ = webview.with_webview(disable_webview_context_menus);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            load_app_settings,
            save_app_settings,
            compile_typst_document,
            compile_typst_preview,
            check_typst_document,
            read_workspace_file,
            workspace_path_exists,
            cleanup_workspace_preview_files,
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
            install_unicode_font,
            analyze_language_ranges,
            language_suggestions,
            get_provider_capabilities,
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
            map_source_to_generated
        ])
        .run(tauri::generate_context!())
        .expect("Error initializing Tauri execution engine");
}
