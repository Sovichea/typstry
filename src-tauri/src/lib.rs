use serde_json::json;
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use tauri::{Emitter, Manager};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

fn managed_executable_path(data_dir: &std::path::Path, name: &str) -> std::path::PathBuf {
    #[cfg(windows)]
    let file_name = format!("{}.exe", name);
    #[cfg(not(windows))]
    let file_name = name.to_string();

    data_dir.join(file_name)
}

fn executable_available(executable: &std::path::Path) -> bool {
    let mut command = std::process::Command::new(executable);
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);

    command
        .arg("--version")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

fn resolve_executable(data_dir: &std::path::Path, name: &str) -> Option<std::path::PathBuf> {
    let managed = managed_executable_path(data_dir, name);
    if managed.is_file() {
        return Some(managed);
    }

    let path_command = std::path::PathBuf::from(name);
    executable_available(&path_command).then_some(path_command)
}

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

#[tauri::command]
fn resolve_preview_main(
    file_path: String,
    workspace_root_path: Option<String>,
    file_contents: Option<String>,
) -> Result<Option<String>, String> {
    let path = std::path::PathBuf::from(&file_path);
    if path.extension().and_then(|ext| ext.to_str()) != Some("typ") {
        return Ok(None);
    }

    if let Some(file_name) = path.file_name().and_then(|name| name.to_str()) {
        let lower_name = file_name.to_ascii_lowercase();
        if lower_name == "main.typ" || lower_name == "index.typ" || lower_name == "document.typ" {
            return Ok(Some(path.to_string_lossy().to_string()));
        }
    }

    let contents = match file_contents {
        Some(contents) => contents,
        None => {
            std::fs::read_to_string(&path).map_err(|e| format!("Failed to read file: {}", e))?
        }
    };
    if typst_file_has_renderable_content(&contents) {
        return Ok(Some(path.to_string_lossy().to_string()));
    }

    let workspace_root = workspace_root_path.map(std::path::PathBuf::from);
    if let Some(parent) = path.parent() {
        for ancestor in parent.ancestors() {
            if let Some(root) = workspace_root.as_ref() {
                if !ancestor.starts_with(root) {
                    break;
                }
            }

            for candidate_name in ["main.typ", "index.typ", "document.typ"] {
                let candidate = ancestor.join(candidate_name);
                if candidate.exists() {
                    return Ok(Some(candidate.to_string_lossy().to_string()));
                }
            }

            if workspace_root.as_ref().is_some_and(|root| ancestor == root) {
                break;
            }
        }
    }

    Ok(None)
}

fn typst_file_has_renderable_content(contents: &str) -> bool {
    contents.lines().any(|line| {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with("//") || trimmed.starts_with("/*") {
            return false;
        }

        if trimmed.starts_with('=') {
            return true;
        }

        if !trimmed.starts_with('#') {
            return true;
        }

        !(trimmed.starts_with("#let")
            || trimmed.starts_with("#import")
            || trimmed.starts_with("#include")
            || trimmed.starts_with("#show")
            || trimmed.starts_with("#set"))
    })
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
    let input_path = parent.join(format!(".{}.typstry-check.typ", file_stem));
    let output_path = parent.join(format!(".{}.typstry-check.svg", file_stem));

    let data_dir = app_handle
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("Failed to get data dir: {}", e))?;
    let typst_cmd = resolve_executable(&data_dir, "typst")
        .ok_or_else(|| "Typst was not found in the app data directory or PATH.".to_string())?;

    std::fs::write(&input_path, source_code).map_err(|e| format!("Check write failed: {}", e))?;

    let mut command = std::process::Command::new(&typst_cmd);
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);

    let output = command
        .arg("compile")
        .arg("--diagnostic-format")
        .arg("short")
        .arg("--format")
        .arg("svg")
        .arg(&input_path)
        .arg(&output_path)
        .output()
        .map_err(|e| format!("Typst check failed to start: {}", e));

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
    let typst_cmd = resolve_executable(&data_dir, "typst")
        .ok_or_else(|| "Typst was not found in the app data directory or PATH.".to_string())?;

    let mut file = std::fs::File::create(&input_path).map_err(|e| format!("IO Failure: {}", e))?;
    std::io::Write::write_all(&mut file, source_code.as_bytes())
        .map_err(|e| format!("Buffer Flush Failure: {}", e))?;

    let mut command = std::process::Command::new(&typst_cmd);
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);

    let output = command
        .arg("compile")
        .arg(&input_path)
        .arg(&output_path)
        .output()
        .map_err(|e| format!("Host binary execution blocked: {}", e))?;

    let _ = std::fs::remove_file(&input_path);

    if !output.status.success() {
        let stderr_string = String::from_utf8_lossy(&output.stderr).to_string();
        return Err(stderr_string);
    }

    Ok(output_path.to_string_lossy().to_string())
}

#[cfg(test)]
mod preview_main_tests {
    use super::resolve_preview_main;

    #[test]
    fn renderable_active_file_takes_priority_over_workspace_main() {
        let workspace = tempfile::tempdir().expect("create workspace");
        let main_path = workspace.path().join("main.typ");
        let chapter_path = workspace.path().join("chapter.typ");
        std::fs::write(&main_path, "Main document").expect("write main");
        std::fs::write(&chapter_path, "Chapter document").expect("write chapter");

        let resolved = resolve_preview_main(
            chapter_path.to_string_lossy().to_string(),
            Some(workspace.path().to_string_lossy().to_string()),
            None,
        )
        .expect("resolve preview");

        assert_eq!(resolved, Some(chapter_path.to_string_lossy().to_string()));
    }

    #[test]
    fn workspace_main_remains_fallback_for_declaration_only_file() {
        let workspace = tempfile::tempdir().expect("create workspace");
        let main_path = workspace.path().join("main.typ");
        let library_path = workspace.path().join("library.typ");
        std::fs::write(&main_path, "Main document").expect("write main");
        std::fs::write(&library_path, "#let helper = 1").expect("write library");

        let resolved = resolve_preview_main(
            library_path.to_string_lossy().to_string(),
            Some(workspace.path().to_string_lossy().to_string()),
            None,
        )
        .expect("resolve preview");

        assert_eq!(resolved, Some(main_path.to_string_lossy().to_string()));
    }

    #[test]
    fn in_memory_contents_determine_renderability() {
        let workspace = tempfile::tempdir().expect("create workspace");
        let main_path = workspace.path().join("main.typ");
        let draft_path = workspace.path().join("draft.typ");
        std::fs::write(&main_path, "Main document").expect("write main");
        std::fs::write(&draft_path, "#let draft = true").expect("write draft");

        let resolved = resolve_preview_main(
            draft_path.to_string_lossy().to_string(),
            Some(workspace.path().to_string_lossy().to_string()),
            Some("Unsaved rendered draft".to_string()),
        )
        .expect("resolve preview");

        assert_eq!(resolved, Some(draft_path.to_string_lossy().to_string()));
    }
}

#[tauri::command]
async fn ensure_toolchain(app_handle: tauri::AppHandle) -> Result<String, String> {
    use tauri::Manager;
    let data_dir = app_handle
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("Failed to get data dir: {}", e))?;
    std::fs::create_dir_all(&data_dir).map_err(|e| format!("Failed to create data dir: {}", e))?;

    if resolve_executable(&data_dir, "typst").is_some()
        && resolve_executable(&data_dir, "tinymist").is_some()
    {
        return Ok("Toolchain is ready.".to_string());
    }

    #[cfg(not(windows))]
    return Err(
        "Typst and Tinymist must be installed and available in PATH on this platform.".to_string(),
    );

    #[cfg(windows)]
    {
        let script = format!(
            r#"
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$DataDir = "{}"

if (!(Test-Path "$DataDir\tinymist.exe")) {{
    Write-Host "Downloading Tinymist..."
    curl.exe -L -o "$DataDir\tinymist.exe" "https://github.com/Myriad-Dreamin/tinymist/releases/download/v0.15.2/tinymist-win32-x64.exe"
}}

if (!(Test-Path "$DataDir\typst.exe")) {{
    Write-Host "Downloading Typst..."
    curl.exe -L -o "$DataDir\typst.zip" "https://github.com/typst/typst/releases/download/v0.15.0/typst-x86_64-pc-windows-msvc.zip"
    Expand-Archive -Path "$DataDir\typst.zip" -DestinationPath "$DataDir\typst_extracted" -Force
    Move-Item -Path "$DataDir\typst_extracted\typst-x86_64-pc-windows-msvc\typst.exe" -Destination "$DataDir\typst.exe" -Force
    Remove-Item "$DataDir\typst.zip"
    Remove-Item "$DataDir\typst_extracted" -Recurse -Force
}}
"#,
            data_dir.to_string_lossy()
        );

        let script_path = data_dir.join("download_toolchain.ps1");
        std::fs::write(&script_path, script)
            .map_err(|e| format!("Failed to write script: {}", e))?;

        let mut command = std::process::Command::new("powershell");
        #[cfg(windows)]
        command.creation_flags(CREATE_NO_WINDOW);

        let output = command
            .arg("-ExecutionPolicy")
            .arg("Bypass")
            .arg("-File")
            .arg(&script_path)
            .output()
            .map_err(|e| format!("Failed to execute powershell: {}", e))?;

        let _ = std::fs::remove_file(&script_path);

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("Toolchain download failed: {}", stderr));
        }

        Ok("Toolchain downloaded successfully.".to_string())
    }
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
    let tinymist_exe = resolve_executable(&data_dir, "tinymist")
        .ok_or_else(|| "Tinymist was not found in the app data directory or PATH.".to_string())?;

    let mut command = tokio::process::Command::new(&tinymist_exe);
    command
        .arg("lsp")
        .env("VSCODE_PROXY_URI", "http://tauri.localhost/{{port}}")
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
    if let Some(tx) = state.tx.lock().unwrap().as_ref() {
        let _ = tx.try_send(message);
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(LspState {
            generation: AtomicU64::new(0),
            tx: Mutex::new(None),
            process: Mutex::new(None),
        })
        .setup(|app| {
            if let Some(webview) = app.get_webview_window("main") {
                let _ = webview.with_webview(disable_webview_context_menus);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            load_app_settings,
            save_app_settings,
            compile_typst_document,
            check_typst_document,
            read_workspace_file,
            save_workspace_file,
            create_workspace_dir,
            rename_workspace_file,
            copy_workspace_file,
            read_workspace_dir,
            move_to_trash,
            reveal_in_explorer,
            resolve_preview_main,
            ensure_toolchain,
            start_tinymist_lsp,
            send_lsp_message
        ])
        .run(tauri::generate_context!())
        .expect("Error initializing Tauri execution engine");
}
