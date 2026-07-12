use serde::Serialize;
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScaledFontResult {
    pub directory: PathBuf,
    pub family: String,
    pub scale: f32,
    pub generated_files: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ScaledFontManifest<'a> {
    version: u32,
    family: &'a str,
    scale: f32,
    files: &'a [String],
}

fn safe_file_stem(value: &str) -> String {
    let value: String = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
                character
            } else {
                '-'
            }
        })
        .collect();
    value.trim_matches('-').to_string()
}

fn stable_hash(bytes: &[u8], face_index: u32, scale: f32) -> u64 {
    let mut hash = 0xcbf2_9ce4_8422_2325u64;
    for byte in bytes
        .iter()
        .copied()
        .chain(face_index.to_be_bytes())
        .chain(scale.to_bits().to_be_bytes())
    {
        hash ^= byte as u64;
        hash = hash.wrapping_mul(0x100_0000_01b3);
    }
    hash
}

fn read_source(source: &fontdb::Source) -> Result<(Vec<u8>, Option<&Path>), String> {
    match source {
        fontdb::Source::File(path) => fs::read(path)
            .map(|bytes| (bytes, Some(path.as_path())))
            .map_err(|error| format!("Failed to read {}: {error}", path.display())),
        fontdb::Source::Binary(bytes) => Ok((bytes.as_ref().as_ref().to_vec(), None)),
        fontdb::Source::SharedFile(path, bytes) => {
            Ok((bytes.as_ref().as_ref().to_vec(), Some(path.as_path())))
        }
    }
}

pub fn prepare_scaled_workspace_font(
    workspace_root: &Path,
    family: &str,
    scale: f32,
) -> Result<ScaledFontResult, String> {
    if family.trim().is_empty() {
        return Err("A complex-script font family is required.".into());
    }
    if !scale.is_finite() || !(0.5..=2.0).contains(&scale) {
        return Err("Complex-script font scale must be between 0.5 and 2.0.".into());
    }
    if !workspace_root.is_dir() {
        return Err("The workspace root does not exist.".into());
    }

    let fonts_dir = workspace_root.join(".typstella").join("fonts");
    let generated_dir = fonts_dir.join("generated");
    if generated_dir.exists() {
        fs::remove_dir_all(&generated_dir)
            .map_err(|error| format!("Failed to replace {}: {error}", generated_dir.display()))?;
    }
    fs::create_dir_all(&generated_dir)
        .map_err(|error| format!("Failed to create {}: {error}", generated_dir.display()))?;
    fs::write(fonts_dir.join(".gitignore"), "generated/\n")
        .map_err(|error| format!("Failed to protect generated fonts from Git: {error}"))?;

    let mut generated_files = Vec::new();
    if (scale - 1.0).abs() > 0.0001 {
        let mut database = fontdb::Database::new();
        database.load_system_fonts();
        let faces: Vec<_> = database
            .faces()
            .filter(|face| {
                face.families
                    .iter()
                    .any(|(candidate, _)| candidate.eq_ignore_ascii_case(family))
            })
            .cloned()
            .collect();
        if faces.is_empty() {
            return Err(format!(
                "The system font family {family:?} could not be located."
            ));
        }

        let mut written_sources = BTreeSet::new();
        for face in faces {
            let (bytes, source_path) = read_source(&face.source)?;
            let source_key = source_path
                .map(|path| path.to_string_lossy().into_owned())
                .unwrap_or_else(|| format!("binary-{}", stable_hash(&bytes, face.index, 1.0)));
            if !written_sources.insert(source_key) {
                continue;
            }
            if face.index != 0 || bytes.get(..4) == Some(b"ttcf") {
                return Err(format!(
                    "{family:?} is stored in a font collection. Select an individual TTF or OTF face for scaling."
                ));
            }
            let scaled = typstella_font_scaler::scale_font_uniform(&bytes, scale)
                .map_err(|error| format!("Failed to scale {family:?}: {error}"))?;
            let extension = source_path
                .and_then(Path::extension)
                .and_then(|extension| extension.to_str())
                .filter(|extension| {
                    matches!(extension.to_ascii_lowercase().as_str(), "ttf" | "otf")
                })
                .unwrap_or("ttf");
            let file_name = format!(
                "{}-{:016x}.{}",
                safe_file_stem(family),
                stable_hash(&bytes, face.index, scale),
                extension
            );
            let destination = generated_dir.join(&file_name);
            let mut temporary = tempfile::NamedTempFile::new_in(&generated_dir)
                .map_err(|error| format!("Failed to stage scaled font: {error}"))?;
            std::io::Write::write_all(&mut temporary, &scaled)
                .map_err(|error| format!("Failed to write scaled font: {error}"))?;
            temporary
                .persist(&destination)
                .map_err(|error| format!("Failed to install scaled font: {}", error.error))?;
            generated_files.push(file_name);
        }
    }

    let manifest = ScaledFontManifest {
        version: 1,
        family,
        scale,
        files: &generated_files,
    };
    fs::write(
        generated_dir.join("manifest.json"),
        serde_json::to_vec_pretty(&manifest).map_err(|error| error.to_string())?,
    )
    .map_err(|error| format!("Failed to write scaled-font manifest: {error}"))?;

    Ok(ScaledFontResult {
        directory: generated_dir,
        family: family.to_string(),
        scale,
        generated_files,
    })
}

pub fn clear_scaled_workspace_fonts(workspace_root: &Path) -> Result<(), String> {
    if !workspace_root.is_dir() {
        return Err("The workspace root does not exist.".into());
    }
    let generated_dir = workspace_root
        .join(".typstella")
        .join("fonts")
        .join("generated");
    if generated_dir.exists() {
        fs::remove_dir_all(&generated_dir)
            .map_err(|error| format!("Failed to remove {}: {error}", generated_dir.display()))?;
    }
    Ok(())
}
