use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InputLanguageStatus {
    language_tag: Option<String>,
    reliability: &'static str,
    source: &'static str,
}

#[tauri::command]
pub fn get_input_language() -> InputLanguageStatus {
    #[cfg(debug_assertions)]
    if let Ok(value) = std::env::var("TYPSASTRA_DEV_INPUT_LANGUAGE") {
        let language_tag = normalize_tag(&value);
        return InputLanguageStatus {
            reliability: if language_tag.is_some() {
                "reliable"
            } else {
                "unmapped"
            },
            language_tag,
            source: "development-override",
        };
    }

    platform_input_language()
}

#[cfg(windows)]
fn platform_input_language() -> InputLanguageStatus {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::GetKeyboardLayout;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetGUIThreadInfo, GetWindowThreadProcessId, GUITHREADINFO,
    };
    let foreground = unsafe { GetForegroundWindow() };
    let mut gui = GUITHREADINFO {
        cbSize: std::mem::size_of::<GUITHREADINFO>() as u32,
        ..unsafe { std::mem::zeroed() }
    };
    let focused = if unsafe { GetGUIThreadInfo(0, &mut gui) } != 0 && !gui.hwndFocus.is_null() {
        gui.hwndFocus
    } else {
        foreground
    };
    let thread = unsafe { GetWindowThreadProcessId(focused, std::ptr::null_mut()) };
    let layout = unsafe { GetKeyboardLayout(thread) } as usize;
    let language_id = layout & 0xffff;
    let exact = match language_id {
        0x0401 => Some("ar-SA"),
        0x0409 => Some("en-US"),
        0x0809 => Some("en-GB"),
        0x040a => Some("es-ES"),
        0x040c => Some("fr-FR"),
        0x0c0c => Some("fr-CA"),
        0x0453 => Some("km-KH"),
        0x0454 => Some("lo-LA"),
        _ => None,
    };
    let primary = match language_id & 0x03ff {
        0x01 => Some("ar"),
        0x09 => Some("en"),
        0x0a => Some("es"),
        0x0c => Some("fr"),
        0x53 => Some("km"),
        0x54 => Some("lo"),
        _ => None,
    };
    let reliable = exact.is_some();
    InputLanguageStatus {
        language_tag: exact.or(primary).map(str::to_owned),
        reliability: if reliable { "reliable" } else { "unmapped" },
        source: "windows-keyboard-layout",
    }
}

#[cfg(target_os = "macos")]
fn platform_input_language() -> InputLanguageStatus {
    InputLanguageStatus {
        language_tag: None,
        reliability: "unsupported",
        source: "macos-fallback",
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
fn platform_input_language() -> InputLanguageStatus {
    let language_tag = std::env::var("LANG")
        .ok()
        .and_then(|value| normalize_tag(&value));
    let reliable = language_tag.is_some();
    InputLanguageStatus {
        language_tag,
        reliability: if reliable { "reliable" } else { "unmapped" },
        source: "linux-locale-fallback",
    }
}

fn normalize_tag(value: &str) -> Option<String> {
    let value = value.split('.').next()?.replace('_', "-");
    let mut parts = value.split('-');
    let language = parts.next()?.to_ascii_lowercase();
    if !matches!(language.len(), 2 | 3) || !language.chars().all(|c| c.is_ascii_alphabetic()) {
        return None;
    }
    let region = parts
        .next()
        .filter(|part| part.len() == 2 && part.chars().all(|c| c.is_ascii_alphabetic()));
    Some(match region {
        Some(region) => format!("{language}-{}", region.to_ascii_uppercase()),
        None => language,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_layout_and_locale_tags() {
        assert_eq!(normalize_tag("fr_CA.UTF-8").as_deref(), Some("fr-CA"));
        assert_eq!(normalize_tag("km").as_deref(), Some("km"));
        assert_eq!(normalize_tag("invalid-tag-value"), None);
    }
}
