use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};
use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};
use std::time::Duration;

const MAX_ARCHIVE_BYTES: usize = 160 * 1024 * 1024;
const MAX_FONT_BYTES: usize = 20 * 1024 * 1024;

struct FontFile {
    file_name: &'static str,
    registry_name: &'static str,
    bytes: &'static [u8],
}

const BASE_FONTS: &[FontFile] = &[
    FontFile {
        file_name: "Typstella-FiraMono-Regular.ttf",
        registry_name: "Fira Mono Regular (TrueType)",
        bytes: include_bytes!("../fonts/FiraMono-Regular.ttf"),
    },
    FontFile {
        file_name: "Typstella-FiraMono-Bold.ttf",
        registry_name: "Fira Mono Bold (TrueType)",
        bytes: include_bytes!("../fonts/FiraMono-Bold.ttf"),
    },
    FontFile {
        file_name: "Typstella-MiSansLatin-Regular.ttf",
        registry_name: "MiSans Latin Regular (TrueType)",
        bytes: include_bytes!("../fonts/MiSansLatin-Regular.ttf"),
    },
    FontFile {
        file_name: "Typstella-MiSansLatin-Bold.ttf",
        registry_name: "MiSans Latin Bold (TrueType)",
        bytes: include_bytes!("../fonts/MiSansLatin-Bold.ttf"),
    },
];

struct DownloadSpec {
    id: &'static str,
    family: &'static str,
    archive: &'static str,
    regular_file: &'static str,
    bold_file: &'static str,
}

struct DirectDownloadSpec {
    id: &'static str,
    family: &'static str,
    url: &'static str,
    file_name: &'static str,
}

const DOWNLOADS: &[DownloadSpec] = &[
    DownloadSpec {
        id: "mi-sans",
        family: "MiSans",
        archive: "MiSans",
        regular_file: "MiSans-Regular.ttf",
        bold_file: "MiSans-Bold.ttf",
    },
    DownloadSpec {
        id: "mi-sans-arabic",
        family: "MiSans Arabic",
        archive: "MiSans_Arabic",
        regular_file: "MiSansArabic-Regular.ttf",
        bold_file: "MiSansArabic-Bold.ttf",
    },
    DownloadSpec {
        id: "mi-sans-devanagari",
        family: "MiSans Devanagari",
        archive: "MiSans_Devanagari",
        regular_file: "MiSansDevanagari-Regular.ttf",
        bold_file: "MiSansDevanagari-Bold.ttf",
    },
    DownloadSpec {
        id: "mi-sans-gurmukhi",
        family: "MiSans Gurmukhi",
        archive: "MiSans_Gurmukhi",
        regular_file: "MiSansGurmukhi-Regular.ttf",
        bold_file: "MiSansGurmukhi-Bold.ttf",
    },
    DownloadSpec {
        id: "mi-sans-gujarati",
        family: "MiSans Gujarati",
        archive: "MiSans_Gujarati",
        regular_file: "MiSansGujarati-Regular.ttf",
        bold_file: "MiSansGujarati-Bold.ttf",
    },
    DownloadSpec {
        id: "mi-sans-thai",
        family: "MiSans Thai",
        archive: "MiSans_Thai",
        regular_file: "MiSansThai-Regular.ttf",
        bold_file: "MiSansThai-Bold.ttf",
    },
    DownloadSpec {
        id: "mi-sans-lao",
        family: "MiSans Lao",
        archive: "MiSans_Lao",
        regular_file: "MiSansLao-Regular.ttf",
        bold_file: "MiSansLao-Bold.ttf",
    },
    DownloadSpec {
        id: "mi-sans-myanmar",
        family: "MiSans Myanmar",
        archive: "MiSans_Myanmar",
        regular_file: "MiSansMyanmar-Regular.ttf",
        bold_file: "MiSansMyanmar-Bold.ttf",
    },
    DownloadSpec {
        id: "mi-sans-khmer",
        family: "MiSans Khmer",
        archive: "MiSans_Khmer",
        regular_file: "MiSansKhmer-Regular.ttf",
        bold_file: "MiSansKhmer-Bold.ttf",
    },
    DownloadSpec {
        id: "mi-sans-tibetan",
        family: "MiSans Tibetan",
        archive: "MiSans_Tibetan",
        regular_file: "MiSansTibetan-Regular.ttf",
        bold_file: "MiSansTibetan-Bold.ttf",
    },
];

const DIRECT_DOWNLOADS: &[DirectDownloadSpec] = &[
    DirectDownloadSpec { id: "noto-sans-hebrew", family: "Noto Sans Hebrew", url: "https://raw.githubusercontent.com/google/fonts/main/ofl/notosanshebrew/NotoSansHebrew%5Bwdth%2Cwght%5D.ttf", file_name: "NotoSansHebrew-Variable.ttf" },
    DirectDownloadSpec { id: "noto-sans-armenian", family: "Noto Sans Armenian", url: "https://raw.githubusercontent.com/google/fonts/main/ofl/notosansarmenian/NotoSansArmenian%5Bwdth%2Cwght%5D.ttf", file_name: "NotoSansArmenian-Variable.ttf" },
    DirectDownloadSpec { id: "noto-sans-bengali", family: "Noto Sans Bengali", url: "https://raw.githubusercontent.com/google/fonts/main/ofl/notosansbengali/NotoSansBengali%5Bwdth%2Cwght%5D.ttf", file_name: "NotoSansBengali-Variable.ttf" },
    DirectDownloadSpec { id: "noto-sans-oriya", family: "Noto Sans Oriya", url: "https://raw.githubusercontent.com/google/fonts/main/ofl/notosansoriya/NotoSansOriya%5Bwdth%2Cwght%5D.ttf", file_name: "NotoSansOriya-Variable.ttf" },
    DirectDownloadSpec { id: "noto-sans-tamil", family: "Noto Sans Tamil", url: "https://raw.githubusercontent.com/google/fonts/main/ofl/notosanstamil/NotoSansTamil%5Bwdth%2Cwght%5D.ttf", file_name: "NotoSansTamil-Variable.ttf" },
    DirectDownloadSpec { id: "noto-sans-telugu", family: "Noto Sans Telugu", url: "https://raw.githubusercontent.com/google/fonts/main/ofl/notosanstelugu/NotoSansTelugu%5Bwdth%2Cwght%5D.ttf", file_name: "NotoSansTelugu-Variable.ttf" },
    DirectDownloadSpec { id: "noto-sans-kannada", family: "Noto Sans Kannada", url: "https://raw.githubusercontent.com/google/fonts/main/ofl/notosanskannada/NotoSansKannada%5Bwdth%2Cwght%5D.ttf", file_name: "NotoSansKannada-Variable.ttf" },
    DirectDownloadSpec { id: "noto-sans-malayalam", family: "Noto Sans Malayalam", url: "https://raw.githubusercontent.com/google/fonts/main/ofl/notosansmalayalam/NotoSansMalayalam%5Bwdth%2Cwght%5D.ttf", file_name: "NotoSansMalayalam-Variable.ttf" },
    DirectDownloadSpec { id: "noto-sans-sinhala", family: "Noto Sans Sinhala", url: "https://raw.githubusercontent.com/google/fonts/main/ofl/notosanssinhala/NotoSansSinhala%5Bwdth%2Cwght%5D.ttf", file_name: "NotoSansSinhala-Variable.ttf" },
    DirectDownloadSpec { id: "noto-sans-georgian", family: "Noto Sans Georgian", url: "https://raw.githubusercontent.com/google/fonts/main/ofl/notosansgeorgian/NotoSansGeorgian%5Bwdth%2Cwght%5D.ttf", file_name: "NotoSansGeorgian-Variable.ttf" },
    DirectDownloadSpec { id: "noto-sans-ethiopic", family: "Noto Sans Ethiopic", url: "https://raw.githubusercontent.com/google/fonts/main/ofl/notosansethiopic/NotoSansEthiopic%5Bwdth%2Cwght%5D.ttf", file_name: "NotoSansEthiopic-Variable.ttf" },
    DirectDownloadSpec { id: "noto-sans-jp", family: "Noto Sans JP", url: "https://raw.githubusercontent.com/google/fonts/main/ofl/notosansjp/NotoSansJP%5Bwght%5D.ttf", file_name: "NotoSansJP-Variable.ttf" },
    DirectDownloadSpec { id: "noto-sans-kr", family: "Noto Sans KR", url: "https://raw.githubusercontent.com/google/fonts/main/ofl/notosanskr/NotoSansKR%5Bwght%5D.ttf", file_name: "NotoSansKR-Variable.ttf" },
];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemFontCatalog {
    all: Vec<String>,
    monospace: Vec<String>,
    scripts: BTreeMap<String, Vec<String>>,
}

const SCRIPT_SAMPLES: &[(&str, &[char])] = &[
    ("khmer", &['ក', 'ខ', 'ម']),
    ("arabic", &['ا', 'ب', 'م']),
    ("thai", &['ก', 'ข', 'ม']),
    ("lao", &['ກ', 'ຂ', 'ມ']),
    ("myanmar", &['က', 'ခ', 'မ']),
    ("devanagari", &['क', 'ख', 'म']),
    ("bengali", &['ক', 'খ', 'ম']),
    ("gurmukhi", &['ਕ', 'ਖ', 'ਮ']),
    ("gujarati", &['ક', 'ખ', 'મ']),
    ("tamil", &['க', 'ங', 'ம']),
    ("telugu", &['క', 'ఖ', 'మ']),
    ("kannada", &['ಕ', 'ಖ', 'ಮ']),
    ("malayalam", &['ക', 'ഖ', 'മ']),
    ("sinhala", &['ක', 'ඛ', 'ම']),
    ("tibetan", &['ཀ', 'ཁ', 'མ']),
    ("hebrew", &['א', 'ב', 'מ']),
    ("armenian", &['Ա', 'Բ', 'Մ']),
    ("georgian", &['ა', 'ბ', 'მ']),
    ("ethiopic", &['ሀ', 'ለ', 'መ']),
    ("han", &['中', '文', '字']),
    ("hiragana", &['あ', 'か', 'ま']),
    ("hangul", &['가', '나', '한']),
];

#[cfg(test)]
fn face_supports_samples(data: &[u8], face_index: u32, samples: &[char]) -> bool {
    ttf_parser::Face::parse(data, face_index)
        .map(|face| parsed_face_supports_samples(&face, samples))
        .unwrap_or(false)
}

fn parsed_face_supports_samples(face: &ttf_parser::Face<'_>, samples: &[char]) -> bool {
    samples
        .iter()
        .all(|character| face.glyph_index(*character).is_some())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledFont {
    family: String,
}

fn user_font_directory() -> Result<PathBuf, String> {
    #[cfg(windows)]
    {
        return std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .map(|path| path.join("Microsoft").join("Windows").join("Fonts"))
            .ok_or_else(|| "LOCALAPPDATA is unavailable.".to_string());
    }
    #[cfg(target_os = "macos")]
    {
        return std::env::var_os("HOME")
            .map(PathBuf::from)
            .map(|path| path.join("Library").join("Fonts"))
            .ok_or_else(|| "HOME is unavailable.".to_string());
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        if let Some(data_home) = std::env::var_os("XDG_DATA_HOME") {
            return Ok(PathBuf::from(data_home).join("fonts"));
        }
        return std::env::var_os("HOME")
            .map(PathBuf::from)
            .map(|path| path.join(".local").join("share").join("fonts"))
            .ok_or_else(|| "HOME is unavailable.".to_string());
    }
}

#[cfg(windows)]
fn register_font(path: &Path, registry_name: &str) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Graphics::Gdi::AddFontResourceExW;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        SendMessageTimeoutW, HWND_BROADCAST, SMTO_ABORTIFHUNG, WM_FONTCHANGE,
    };
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    let fonts = RegKey::predef(HKEY_CURRENT_USER)
        .create_subkey("Software\\Microsoft\\Windows NT\\CurrentVersion\\Fonts")
        .map(|(key, _)| key)
        .map_err(|error| format!("Failed to open the current-user font registry: {error}"))?;
    fonts
        .set_value(registry_name, &path.to_string_lossy().as_ref())
        .map_err(|error| format!("Failed to register {registry_name}: {error}"))?;

    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    unsafe {
        AddFontResourceExW(wide.as_ptr(), 0, std::ptr::null_mut());
        let mut result = 0usize;
        SendMessageTimeoutW(
            HWND_BROADCAST,
            WM_FONTCHANGE,
            0,
            0,
            SMTO_ABORTIFHUNG,
            1000,
            &mut result,
        );
    }
    Ok(())
}

#[cfg(not(windows))]
fn register_font(_path: &Path, _registry_name: &str) -> Result<(), String> {
    Ok(())
}

fn write_and_register(file_name: &str, registry_name: &str, bytes: &[u8]) -> Result<(), String> {
    let directory = user_font_directory()?;
    std::fs::create_dir_all(&directory)
        .map_err(|error| format!("Failed to create the user font directory: {error}"))?;
    let path = directory.join(file_name);
    let current = std::fs::read(&path).ok();
    if current.as_deref() != Some(bytes) {
        std::fs::write(&path, bytes)
            .map_err(|error| format!("Failed to install {file_name}: {error}"))?;
    }
    register_font(&path, registry_name)
}

#[cfg(all(unix, not(target_os = "macos")))]
fn refresh_platform_font_cache() {
    let _ = std::process::Command::new("fc-cache")
        .arg("-f")
        .arg(user_font_directory().unwrap_or_default())
        .status();
}

#[cfg(any(windows, target_os = "macos"))]
fn refresh_platform_font_cache() {}

pub fn ensure_base_fonts_installed() -> Result<(), String> {
    for font in BASE_FONTS {
        write_and_register(font.file_name, font.registry_name, font.bytes)?;
    }
    refresh_platform_font_cache();
    Ok(())
}

pub fn remove_legacy_font_cache(data_dir: &Path) {
    let legacy = data_dir.join("fonts").join("mi-sans-khmer");
    if legacy.is_dir() {
        let _ = std::fs::remove_dir_all(legacy);
    }
}

pub fn list_system_fonts() -> SystemFontCatalog {
    let mut database = fontdb::Database::new();
    database.load_system_fonts();
    let mut all = BTreeSet::new();
    let mut monospace = BTreeSet::new();
    let mut scripts: BTreeMap<String, BTreeSet<String>> = SCRIPT_SAMPLES
        .iter()
        .map(|(script, _)| ((*script).to_string(), BTreeSet::new()))
        .collect();
    for face in database.faces() {
        let supported_scripts = database
            .with_face_data(face.id, |data, face_index| {
                ttf_parser::Face::parse(data, face_index)
                    .map(|parsed_face| {
                        SCRIPT_SAMPLES
                            .iter()
                            .filter(|(_, samples)| {
                                parsed_face_supports_samples(&parsed_face, samples)
                            })
                            .map(|(script, _)| *script)
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default()
            })
            .unwrap_or_default();
        for (family, _) in &face.families {
            all.insert(family.clone());
            if face.monospaced {
                monospace.insert(family.clone());
            }
            for script in &supported_scripts {
                scripts
                    .entry((*script).to_string())
                    .or_default()
                    .insert(family.clone());
            }
        }
    }
    SystemFontCatalog {
        all: all.into_iter().collect(),
        monospace: monospace.into_iter().collect(),
        scripts: scripts
            .into_iter()
            .map(|(script, families)| (script, families.into_iter().collect()))
            .collect(),
    }
}

fn valid_font(bytes: &[u8]) -> bool {
    bytes.len() >= 4 && matches!(&bytes[..4], b"\0\x01\0\0" | b"OTTO" | b"true" | b"ttcf")
}

fn extract_font(
    archive: &mut zip::ZipArchive<Cursor<Vec<u8>>>,
    expected_file: &str,
) -> Result<Vec<u8>, String> {
    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .map_err(|error| format!("Failed to inspect the MiSans archive: {error}"))?;
        let name = Path::new(entry.name())
            .file_name()
            .and_then(|name| name.to_str());
        if !name.is_some_and(|name| name.eq_ignore_ascii_case(expected_file)) {
            continue;
        }
        if entry.size() as usize > MAX_FONT_BYTES {
            return Err(format!("{expected_file} is larger than expected."));
        }
        let mut bytes = Vec::with_capacity(entry.size() as usize);
        entry
            .take(MAX_FONT_BYTES as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|error| format!("Failed to extract {expected_file}: {error}"))?;
        if bytes.len() > MAX_FONT_BYTES || !valid_font(&bytes) {
            return Err(format!("{expected_file} is not a valid desktop font."));
        }
        return Ok(bytes);
    }
    Err(format!(
        "The MiSans archive does not contain {expected_file}."
    ))
}

pub async fn install_unicode_font(font_id: &str) -> Result<InstalledFont, String> {
    if let Some(spec) = DIRECT_DOWNLOADS.iter().find(|spec| spec.id == font_id) {
        let client = reqwest::Client::builder()
            .user_agent(format!("Typstella/{}", env!("CARGO_PKG_VERSION")))
            .timeout(Duration::from_secs(120))
            .build()
            .map_err(|error| format!("Failed to initialize the font downloader: {error}"))?;
        let response = client
            .get(spec.url)
            .send()
            .await
            .map_err(|error| format!("Failed to download {}: {error}", spec.family))?
            .error_for_status()
            .map_err(|error| format!("{} download failed: {error}", spec.family))?;
        if response
            .content_length()
            .is_some_and(|size| size as usize > MAX_FONT_BYTES)
        {
            return Err(format!("{} is larger than expected.", spec.family));
        }
        let bytes = response
            .bytes()
            .await
            .map_err(|error| format!("Failed to read {}: {error}", spec.family))?;
        if bytes.len() > MAX_FONT_BYTES || !valid_font(&bytes) {
            return Err(format!("{} is not a valid desktop font.", spec.family));
        }
        let installed_file = format!("Typstella-{}", spec.file_name);
        write_and_register(
            &installed_file,
            &format!("{} Variable (TrueType)", spec.family),
            &bytes,
        )?;
        refresh_platform_font_cache();
        return Ok(InstalledFont {
            family: spec.family.to_string(),
        });
    }

    let spec = DOWNLOADS
        .iter()
        .find(|spec| spec.id == font_id)
        .ok_or_else(|| format!("Unknown Unicode font recommendation: {font_id}"))?;
    let client = reqwest::Client::builder()
        .user_agent(format!("Typstella/{}", env!("CARGO_PKG_VERSION")))
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|error| format!("Failed to initialize the font downloader: {error}"))?;
    let url = format!("https://hyperos.mi.com/font-download/{}.zip", spec.archive);
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|error| format!("Failed to download {}: {error}", spec.family))?
        .error_for_status()
        .map_err(|error| format!("{} download failed: {error}", spec.family))?;
    if response
        .content_length()
        .is_some_and(|size| size as usize > MAX_ARCHIVE_BYTES)
    {
        return Err(format!(
            "The {} archive is larger than expected.",
            spec.family
        ));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("Failed to read the {} archive: {error}", spec.family))?;
    if bytes.len() > MAX_ARCHIVE_BYTES {
        return Err(format!(
            "The {} archive is larger than expected.",
            spec.family
        ));
    }
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes.to_vec()))
        .map_err(|error| format!("The {} archive is invalid: {error}", spec.family))?;
    let regular = extract_font(&mut archive, spec.regular_file)?;
    let bold = extract_font(&mut archive, spec.bold_file)?;
    let installed_regular = format!("Typstella-{}", spec.regular_file);
    let installed_bold = format!("Typstella-{}", spec.bold_file);
    write_and_register(
        &installed_regular,
        &format!("{} Regular (TrueType)", spec.family),
        &regular,
    )?;
    write_and_register(
        &installed_bold,
        &format!("{} Bold (TrueType)", spec.family),
        &bold,
    )?;
    refresh_platform_font_cache();
    Ok(InstalledFont {
        family: spec.family.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_desktop_font_signatures() {
        assert!(valid_font(b"\0\x01\0\0font"));
        assert!(valid_font(b"OTTOfont"));
        assert!(!valid_font(b"wOF2font"));
    }

    #[test]
    fn recommendations_are_unique() {
        let ids: BTreeSet<_> = DOWNLOADS
            .iter()
            .map(|spec| spec.id)
            .chain(DIRECT_DOWNLOADS.iter().map(|spec| spec.id))
            .collect();
        assert_eq!(ids.len(), DOWNLOADS.len() + DIRECT_DOWNLOADS.len());
    }

    #[test]
    fn bundled_fonts_are_installable_desktop_fonts() {
        assert!(BASE_FONTS.iter().all(|font| valid_font(font.bytes)));
    }

    #[test]
    fn detects_script_support_from_font_cmaps() {
        let fira = BASE_FONTS
            .iter()
            .find(|font| font.file_name.contains("FiraMono-Regular"))
            .expect("bundled Fira Mono");
        assert!(face_supports_samples(fira.bytes, 0, &['A', 'm']));
        assert!(!face_supports_samples(fira.bytes, 0, &['ក', 'ខ', 'ម']));
    }

    #[test]
    #[ignore = "installs fonts in the current user's operating-system font collection"]
    fn installs_and_enumerates_bundled_fonts() {
        ensure_base_fonts_installed().expect("install bundled fonts");
        let catalog = list_system_fonts();
        assert!(catalog.all.iter().any(|family| family == "MiSans Latin"));
        assert!(catalog.monospace.iter().any(|family| family == "Fira Mono"));
    }
}
