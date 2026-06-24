use serde_json::json;
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use tauri::{Emitter, Manager};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[tauri::command]
fn read_workspace_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("Failed to read file: {}", e))
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

    let contents =
        std::fs::read_to_string(&path).map_err(|e| format!("Failed to read file: {}", e))?;
    if typst_file_has_renderable_content(&contents) {
        Ok(Some(path.to_string_lossy().to_string()))
    } else {
        Ok(None)
    }
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

    std::fs::write(&input_path, source_code).map_err(|e| format!("Check write failed: {}", e))?;

    let data_dir = app_handle.path().app_local_data_dir().unwrap_or_default();
    let local_typst = data_dir.join("typst.exe");
    let typst_cmd = if local_typst.exists() {
        local_typst.to_string_lossy().to_string()
    } else {
        "typst".to_string()
    };

    let mut command = std::process::Command::new(typst_cmd);
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

    let input_path = parent.join(format!(".{}.preview.typ", file_stem));
    let output_path_template = parent.join(format!(".{}.preview-{{p}}.svg", file_stem));

    let mut file = std::fs::File::create(&input_path).map_err(|e| format!("IO Failure: {}", e))?;
    std::io::Write::write_all(&mut file, source_code.as_bytes())
        .map_err(|e| format!("Buffer Flush Failure: {}", e))?;

    let data_dir = app_handle.path().app_local_data_dir().unwrap_or_default();
    let local_typst = data_dir.join("typst.exe");
    let typst_cmd = if local_typst.exists() {
        local_typst.to_string_lossy().to_string()
    } else {
        "typst".to_string()
    };

    let mut command = std::process::Command::new(typst_cmd);
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);

    let output = command
        .arg("compile")
        .arg("--format")
        .arg("svg")
        .arg(&input_path)
        .arg(output_path_template.to_string_lossy().as_ref())
        .output()
        .map_err(|e| format!("Host binary execution blocked: {}", e))?;

    let _ = std::fs::remove_file(&input_path);

    if !output.status.success() {
        let stderr_string = String::from_utf8_lossy(&output.stderr).to_string();
        return Err(stderr_string);
    }

    let mut combined_svg = String::new();
    let mut page = 1;
    loop {
        let page_path = parent.join(format!(".{}.preview-{}.svg", file_stem, page));
        if !page_path.exists() {
            break;
        }

        if let Ok(svg) = std::fs::read_to_string(&page_path) {
            combined_svg.push_str(&format!("<div class='typst-page' style='margin-bottom: 20px; box-shadow: 0 4px 12px rgba(0,0,0,0.15);'>\n{}\n</div>", svg));
        }
        let _ = std::fs::remove_file(&page_path);
        page += 1;
    }

    Ok(combined_svg)
}

#[tauri::command]
async fn ensure_toolchain(app_handle: tauri::AppHandle) -> Result<String, String> {
    use tauri::Manager;
    let data_dir = app_handle
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("Failed to get data dir: {}", e))?;
    std::fs::create_dir_all(&data_dir).map_err(|e| format!("Failed to create data dir: {}", e))?;

    let typst_exe = data_dir.join("typst.exe");
    let tinymist_exe = data_dir.join("tinymist.exe");

    if typst_exe.exists() && tinymist_exe.exists() {
        return Ok("Toolchain is ready.".to_string());
    }

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
    std::fs::write(&script_path, script).map_err(|e| format!("Failed to write script: {}", e))?;

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

    let data_dir = app_handle.path().app_local_data_dir().unwrap_or_default();
    let tinymist_exe = data_dir.join("tinymist.exe");

    if !tinymist_exe.exists() {
        return Err("Tinymist not found. Please restart to download.".to_string());
    }

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
            compile_typst_document,
            check_typst_document,
            read_workspace_file,
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
