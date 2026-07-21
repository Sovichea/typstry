use serde::{Deserialize, Serialize};
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
    pub changed: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScaledFontRequest {
    pub family: String,
    pub scale: f32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScaledFontSetStatus {
    pub update_required: bool,
    pub generation_required: bool,
    pub variant_limit_warnings: Vec<FontVariantLimitWarning>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FontVariantLimitWarning {
    pub family: String,
    pub cached_variants: usize,
    pub requested_scale: f32,
    pub recommended_limit: usize,
}

pub const RECOMMENDED_VARIANTS_PER_FONT_FACE: usize = 10;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceFontSelection {
    version: u32,
    fonts: Vec<ScaledFontRequest>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ScaledFontManifest<'a> {
    version: u32,
    family: &'a str,
    scale: f32,
    files: &'a [String],
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredScaledFontManifest {
    family: String,
    scale: f32,
    files: Vec<String>,
}

fn validate_request(workspace_root: &Path, family: &str, scale: f32) -> Result<(), String> {
    if family.trim().is_empty() {
        return Err("A document font family is required.".into());
    }
    if !scale.is_finite() || !(0.5..=2.0).contains(&scale) {
        return Err("Document font scale must be between 0.5 and 2.0.".into());
    }
    if !workspace_root.is_dir() {
        return Err("The workspace root does not exist.".into());
    }
    Ok(())
}

fn current_manifest(generated_dir: &Path) -> Option<StoredScaledFontManifest> {
    let manifest: StoredScaledFontManifest =
        serde_json::from_slice(&fs::read(generated_dir.join("manifest.json")).ok()?).ok()?;
    manifest
        .files
        .iter()
        .all(|file| generated_dir.join(file).is_file())
        .then_some(manifest)
}

pub fn global_scaled_font_root(app_local_data_dir: &Path) -> PathBuf {
    app_local_data_dir.join("font-cache").join("scaled")
}

fn path_hash(path: &Path) -> u64 {
    let normalized = path
        .canonicalize()
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .replace('\\', "/")
        .to_ascii_lowercase();
    let mut hash = 0xcbf2_9ce4_8422_2325u64;
    for byte in normalized.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x100_0000_01b3);
    }
    hash
}

fn selection_path(cache_root: &Path, workspace_root: &Path) -> PathBuf {
    cache_root
        .join("workspaces")
        .join(format!("{:016x}.json", path_hash(workspace_root)))
}

fn generated_family_dir(cache_root: &Path, family: &str, scale: f32) -> PathBuf {
    let normalized_family = family.to_ascii_lowercase();
    generated_family_root(cache_root, &normalized_family).join(format!("{:08x}", scale.to_bits()))
}

fn generated_family_root(cache_root: &Path, normalized_family: &str) -> PathBuf {
    cache_root.join("variants").join(format!(
        "{}-{:016x}",
        safe_file_stem(&normalized_family),
        stable_hash(normalized_family.as_bytes(), 0, 1.0)
    ))
}

fn cached_variant_count(cache_root: &Path, family: &str) -> usize {
    let root = generated_family_root(cache_root, &family.to_ascii_lowercase());
    fs::read_dir(root)
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .filter(|entry| entry.path().is_dir() && current_manifest(&entry.path()).is_some())
        .count()
}

fn requested_scaled_fonts(
    workspace_root: &Path,
    requests: &[ScaledFontRequest],
) -> Result<Vec<ScaledFontRequest>, String> {
    let mut requested = std::collections::BTreeMap::<String, ScaledFontRequest>::new();
    for request in requests {
        validate_request(workspace_root, &request.family, request.scale)?;
        let key = request.family.to_lowercase();
        if requested
            .get(&key)
            .is_some_and(|existing| (existing.scale - request.scale).abs() > 0.0001)
        {
            return Err(format!(
                "The font family {:?} cannot use different scales for different scripts. Choose separate families or use one scale.",
                request.family
            ));
        }
        if (request.scale - 1.0).abs() > 0.0001 {
            requested.insert(key, request.clone());
        }
    }
    Ok(requested.into_values().collect())
}

fn current_selection(cache_root: &Path, workspace_root: &Path) -> Vec<ScaledFontRequest> {
    serde_json::from_slice::<WorkspaceFontSelection>(
        &fs::read(selection_path(cache_root, workspace_root)).unwrap_or_default(),
    )
    .map(|selection| selection.fonts)
    .unwrap_or_default()
}

fn same_requests(left: &[ScaledFontRequest], right: &[ScaledFontRequest]) -> bool {
    left.len() == right.len()
        && left.iter().zip(right).all(|(left, right)| {
            left.family.eq_ignore_ascii_case(&right.family)
                && (left.scale - right.scale).abs() <= 0.0001
        })
}

pub fn scaled_workspace_font_update_required(
    cache_root: &Path,
    workspace_root: &Path,
    family: &str,
    scale: f32,
) -> Result<bool, String> {
    validate_request(workspace_root, family, scale)?;
    if (scale - 1.0).abs() <= 0.0001 {
        return Ok(false);
    }
    let generated_dir = generated_family_dir(cache_root, family, scale);
    let Some(manifest) = current_manifest(&generated_dir) else {
        return Ok(true);
    };
    Ok(!manifest.family.eq_ignore_ascii_case(family) || (manifest.scale - scale).abs() > 0.0001)
}

pub fn scaled_workspace_font_set_update_required(
    cache_root: &Path,
    workspace_root: &Path,
    requests: &[ScaledFontRequest],
) -> Result<bool, String> {
    Ok(scaled_workspace_font_set_status(cache_root, workspace_root, requests)?.update_required)
}

pub fn scaled_workspace_font_set_status(
    cache_root: &Path,
    workspace_root: &Path,
    requests: &[ScaledFontRequest],
) -> Result<ScaledFontSetStatus, String> {
    let desired = requested_scaled_fonts(workspace_root, requests)?;
    let generation_required = desired.iter().any(|request| {
        scaled_workspace_font_update_required(
            cache_root,
            workspace_root,
            &request.family,
            request.scale,
        )
        .unwrap_or(true)
    });
    let variant_limit_warnings = desired
        .iter()
        .filter(|request| {
            scaled_workspace_font_update_required(
                cache_root,
                workspace_root,
                &request.family,
                request.scale,
            )
            .unwrap_or(true)
        })
        .filter_map(|request| {
            let cached_variants = cached_variant_count(cache_root, &request.family);
            (cached_variants >= RECOMMENDED_VARIANTS_PER_FONT_FACE).then(|| {
                FontVariantLimitWarning {
                    family: request.family.clone(),
                    cached_variants,
                    requested_scale: request.scale,
                    recommended_limit: RECOMMENDED_VARIANTS_PER_FONT_FACE,
                }
            })
        })
        .collect();
    let selection_changed =
        !same_requests(&desired, &current_selection(cache_root, workspace_root));
    Ok(ScaledFontSetStatus {
        update_required: selection_changed || generation_required,
        generation_required,
        variant_limit_warnings,
    })
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
    cache_root: &Path,
    workspace_root: &Path,
    family: &str,
    scale: f32,
) -> Result<ScaledFontResult, String> {
    validate_request(workspace_root, family, scale)?;

    let generated_dir = generated_family_dir(cache_root, family, scale);
    if !scaled_workspace_font_update_required(cache_root, workspace_root, family, scale)? {
        let generated_files = current_manifest(&generated_dir)
            .map(|manifest| manifest.files)
            .unwrap_or_default();
        return Ok(ScaledFontResult {
            directory: generated_dir,
            family: family.to_string(),
            scale,
            generated_files,
            changed: false,
        });
    }
    if generated_dir.exists() {
        fs::remove_dir_all(&generated_dir)
            .map_err(|error| format!("Failed to replace {}: {error}", generated_dir.display()))?;
    }
    if (scale - 1.0).abs() <= 0.0001 {
        return Ok(ScaledFontResult {
            directory: generated_dir,
            family: family.to_string(),
            scale,
            generated_files: Vec::new(),
            changed: true,
        });
    }
    fs::create_dir_all(&generated_dir)
        .map_err(|error| format!("Failed to create {}: {error}", generated_dir.display()))?;

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
            let scaled = typsastra_font_scaler::scale_font_uniform(&bytes, scale)
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
        changed: true,
    })
}

pub fn activate_scaled_workspace_fonts(
    cache_root: &Path,
    workspace_root: &Path,
    requests: &[ScaledFontRequest],
) -> Result<bool, String> {
    let desired = requested_scaled_fonts(workspace_root, requests)?;
    for request in &desired {
        if scaled_workspace_font_update_required(
            cache_root,
            workspace_root,
            &request.family,
            request.scale,
        )? {
            return Err(format!(
                "The global scaled-font cache for {:?} at {}x is not ready.",
                request.family, request.scale
            ));
        }
    }
    let changed = !same_requests(&desired, &current_selection(cache_root, workspace_root));
    if !changed {
        return Ok(false);
    }
    let path = selection_path(cache_root, workspace_root);
    if desired.is_empty() {
        if path.exists() {
            fs::remove_file(&path)
                .map_err(|error| format!("Failed to clear {}: {error}", path.display()))?;
        }
        return Ok(true);
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create {}: {error}", parent.display()))?;
    }
    fs::write(
        &path,
        serde_json::to_vec_pretty(&WorkspaceFontSelection {
            version: 1,
            fonts: desired,
        })
        .map_err(|error| error.to_string())?,
    )
    .map_err(|error| format!("Failed to write {}: {error}", path.display()))?;
    Ok(true)
}

pub fn workspace_font_directories(cache_root: &Path, workspace_root: &Path) -> Vec<PathBuf> {
    current_selection(cache_root, workspace_root)
        .into_iter()
        .map(|request| generated_family_dir(cache_root, &request.family, request.scale))
        .filter(|directory| current_manifest(directory).is_some())
        .collect()
}

pub fn remove_legacy_workspace_fonts(workspace_root: &Path) -> Result<bool, String> {
    let fonts = workspace_root.join(".typsastra").join("fonts");
    if !fonts.exists() {
        return Ok(false);
    }
    fs::remove_dir_all(&fonts).map_err(|error| {
        format!(
            "Failed to remove legacy project font cache {}: {error}",
            fonts.display()
        )
    })?;
    Ok(true)
}

pub fn clear_scaled_workspace_fonts(
    cache_root: &Path,
    workspace_root: &Path,
) -> Result<bool, String> {
    if !workspace_root.is_dir() {
        return Err("The workspace root does not exist.".into());
    }
    let mut changed = remove_legacy_workspace_fonts(workspace_root)?;
    let selection = selection_path(cache_root, workspace_root);
    if selection.exists() {
        fs::remove_file(&selection)
            .map_err(|error| format!("Failed to remove {}: {error}", selection.display()))?;
        changed = true;
    }
    Ok(changed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seed_variant(cache: &Path, family: &str, scale: f32) -> PathBuf {
        let generated = generated_family_dir(cache, family, scale);
        fs::create_dir_all(&generated).unwrap();
        fs::write(generated.join("cached.ttf"), b"font").unwrap();
        fs::write(
            generated.join("manifest.json"),
            serde_json::json!({
                "version": 1,
                "family": family,
                "scale": scale,
                "files": ["cached.ttf"]
            })
            .to_string(),
        )
        .unwrap();
        generated
    }

    #[test]
    fn unit_scale_is_a_noop_without_generated_fonts() {
        let cache = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        assert!(!scaled_workspace_font_update_required(
            cache.path(),
            workspace.path(),
            "MiSans Khmer",
            1.0
        )
        .unwrap());
        let result =
            prepare_scaled_workspace_font(cache.path(), workspace.path(), "MiSans Khmer", 1.0)
                .unwrap();
        assert!(!result.changed);
        assert!(result.generated_files.is_empty());
        assert!(!result.directory.exists());
    }

    #[test]
    fn cached_variants_survive_workspace_selection_changes() {
        let cache = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let generated = seed_variant(cache.path(), "MiSans Khmer", 1.2);
        activate_scaled_workspace_fonts(
            cache.path(),
            workspace.path(),
            &[ScaledFontRequest {
                family: "MiSans Khmer".into(),
                scale: 1.2,
            }],
        )
        .unwrap();
        clear_scaled_workspace_fonts(cache.path(), workspace.path()).unwrap();
        assert!(generated.exists());
        assert!(workspace_font_directories(cache.path(), workspace.path()).is_empty());
    }

    #[test]
    fn matching_global_variant_is_reused_across_workspaces() {
        let cache = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let other_workspace = tempfile::tempdir().unwrap();
        let generated = seed_variant(cache.path(), "MiSans Khmer", 1.2);
        let matching = [ScaledFontRequest {
            family: "MiSans Khmer".into(),
            scale: 1.2,
        }];
        let status =
            scaled_workspace_font_set_status(cache.path(), workspace.path(), &matching).unwrap();
        assert!(status.update_required);
        assert!(!status.generation_required);
        activate_scaled_workspace_fonts(cache.path(), workspace.path(), &matching).unwrap();
        activate_scaled_workspace_fonts(cache.path(), other_workspace.path(), &matching).unwrap();
        assert_eq!(
            workspace_font_directories(cache.path(), workspace.path()),
            vec![generated.clone()]
        );
        assert_eq!(
            workspace_font_directories(cache.path(), other_workspace.path()),
            vec![generated]
        );
        assert!(!workspace.path().join(".typsastra/fonts").exists());
        assert!(!other_workspace.path().join(".typsastra/fonts").exists());
    }

    #[test]
    fn warns_before_creating_an_eleventh_variant_for_a_font_face() {
        let cache = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        for index in 0..RECOMMENDED_VARIANTS_PER_FONT_FACE {
            seed_variant(cache.path(), "MiSans Khmer", 0.8 + index as f32 * 0.01);
        }

        let requested = [ScaledFontRequest {
            family: "MiSans Khmer".into(),
            scale: 1.2,
        }];
        let status =
            scaled_workspace_font_set_status(cache.path(), workspace.path(), &requested).unwrap();
        assert!(status.generation_required);
        assert_eq!(status.variant_limit_warnings.len(), 1);
        let warning = &status.variant_limit_warnings[0];
        assert_eq!(warning.family, "MiSans Khmer");
        assert_eq!(warning.cached_variants, RECOMMENDED_VARIANTS_PER_FONT_FACE);
        assert_eq!(
            warning.recommended_limit,
            RECOMMENDED_VARIANTS_PER_FONT_FACE
        );
        assert!((warning.requested_scale - 1.2).abs() < 0.0001);

        let cached = [ScaledFontRequest {
            family: "MiSans Khmer".into(),
            scale: 0.8,
        }];
        let cached_status =
            scaled_workspace_font_set_status(cache.path(), workspace.path(), &cached).unwrap();
        assert!(!cached_status.generation_required);
        assert!(cached_status.variant_limit_warnings.is_empty());
    }

    #[test]
    fn rejects_conflicting_scales_for_one_internal_family() {
        let cache = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let requests = [
            ScaledFontRequest {
                family: "Shared Family".into(),
                scale: 0.9,
            },
            ScaledFontRequest {
                family: "Shared Family".into(),
                scale: 1.0,
            },
        ];
        assert!(scaled_workspace_font_set_update_required(
            cache.path(),
            workspace.path(),
            &requests
        )
        .unwrap_err()
        .contains("cannot use different scales"));
    }

    #[test]
    fn removes_legacy_project_font_bytes() {
        let workspace = tempfile::tempdir().unwrap();
        let legacy = workspace.path().join(".typsastra/fonts/generated");
        fs::create_dir_all(&legacy).unwrap();
        fs::write(legacy.join("licensed.ttf"), b"font").unwrap();
        assert!(remove_legacy_workspace_fonts(workspace.path()).unwrap());
        assert!(!workspace.path().join(".typsastra/fonts").exists());
    }
}
