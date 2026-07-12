use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashSet};
use std::fs::File;
use std::io::{Read, Seek, Write};
use std::path::{Path, PathBuf};
use unicode_normalization::UnicodeNormalization;
use zip::write::FileOptions;

pub const PROJECT_FORMAT: &str = "com.typstella.project";
pub const PROJECT_SCHEMA_VERSION: u32 = 1;
pub const PROJECT_MANIFEST_PATH: &str = ".typstella/project.json";
const MAX_ARCHIVE_BYTES: u64 = 512 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES: usize = 20_000;
const MAX_ENTRY_BYTES: u64 = 256 * 1024 * 1024;
const MAX_TOTAL_UNCOMPRESSED_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_MANIFEST_BYTES: u64 = 1024 * 1024;
const MAX_PATH_BYTES: usize = 512;
const MAX_COMPRESSION_RATIO: u64 = 200;
const MAX_PACKAGED_FONT_BYTES: u64 = 64 * 1024 * 1024;
const MAX_TOTAL_PACKAGED_FONT_BYTES: u64 = 256 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectManifest {
    pub format: String,
    pub schema_version: u32,
    pub created_by: CreatedBy,
    pub project: ProjectIdentity,
    pub toolchain: ProjectToolchain,
    pub render_environment: RenderEnvironment,
    pub fonts: Vec<ProjectFont>,
    pub integrity: ProjectIntegrity,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedBy {
    pub application: String,
    pub version: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectIdentity {
    pub name: String,
    pub main: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectToolchain {
    pub typst_version: String,
    pub tinymist_version: String,
    pub compatibility: ToolchainCompatibility,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ToolchainCompatibility {
    Exact,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderEnvironment {
    pub fonts_packaged: bool,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFont {
    pub id: String,
    pub family: String,
    pub postscript_name: String,
    pub style: String,
    pub weight: u16,
    pub stretch: u16,
    pub path: String,
    pub sha256: String,
    #[serde(default)]
    pub face_index: u32,
    #[serde(default)]
    pub format: String,
    #[serde(default)]
    pub variable: bool,
    #[serde(default)]
    pub source: String,
    pub license: ProjectFontLicense,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFontLicense {
    pub name: String,
    pub redistributable: bool,
    #[serde(default)]
    pub modifiable: bool,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectIntegrity {
    pub algorithm: String,
    pub files: BTreeMap<String, String>,
}

#[derive(Clone, Debug)]
struct FileSnapshot {
    absolute_path: PathBuf,
    archive_path: String,
    sha256: String,
}

pub struct ProjectExport<'a> {
    pub workspace_root: &'a Path,
    pub archive_path: &'a Path,
    pub main_file_path: &'a Path,
    pub app_version: &'a str,
    pub typst_version: &'a str,
    pub tinymist_version: &'a str,
    pub packaged_fonts: Option<Vec<ProjectFont>>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveInspection {
    pub manifest: ProjectManifest,
    pub manifest_sha256: String,
    pub entry_count: usize,
    pub total_uncompressed_bytes: u64,
    pub suggested_folder_name: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedProject {
    pub workspace_path: String,
    pub main_file_path: String,
    pub manifest: ProjectManifest,
}

#[derive(Clone, Debug)]
struct ValidatedArchiveEntry {
    index: usize,
    path: String,
    is_directory: bool,
    size: u64,
}

struct ValidatedArchive {
    inspection: ArchiveInspection,
    entries: Vec<ValidatedArchiveEntry>,
}

pub fn validate_manifest_compatibility(manifest: &ProjectManifest) -> Result<(), String> {
    if manifest.format != PROJECT_FORMAT {
        return Err(format!(
            "Unsupported project format '{}'. Expected '{}'.",
            manifest.format, PROJECT_FORMAT
        ));
    }
    if manifest.schema_version != PROJECT_SCHEMA_VERSION {
        return Err(format!(
            "Unsupported Typstella project schema version {}. This build supports version {}.",
            manifest.schema_version, PROJECT_SCHEMA_VERSION
        ));
    }
    if manifest.created_by.application != "Typstella"
        || manifest.created_by.version.trim().is_empty()
    {
        return Err("The project creator metadata is invalid.".to_string());
    }
    if manifest.project.name.trim().is_empty() {
        return Err("The project name is empty.".to_string());
    }
    validate_portable_component(&manifest.project.name)?;
    validate_archive_path(&manifest.project.main)?;
    if !manifest.project.main.ends_with(".typ") {
        return Err("The project main file must be a .typ file.".to_string());
    }
    if manifest.toolchain.typst_version.trim().is_empty()
        || manifest.toolchain.tinymist_version.trim().is_empty()
    {
        return Err("The project toolchain versions are incomplete.".to_string());
    }
    semver::Version::parse(&manifest.toolchain.typst_version)
        .map_err(|_| "The project Typst version is invalid.".to_string())?;
    semver::Version::parse(&manifest.toolchain.tinymist_version)
        .map_err(|_| "The project Tinymist version is invalid.".to_string())?;
    if manifest.integrity.algorithm != "sha256" {
        return Err(format!(
            "Unsupported integrity algorithm '{}'.",
            manifest.integrity.algorithm
        ));
    }
    if !manifest
        .integrity
        .files
        .contains_key(&manifest.project.main)
    {
        return Err("The project main file is missing from the integrity manifest.".to_string());
    }
    for (path, digest) in &manifest.integrity.files {
        validate_archive_path(path)?;
        if digest.len() != 64 || !digest.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(format!("The integrity digest for '{path}' is not SHA-256."));
        }
    }
    if manifest.render_environment.fonts_packaged != !manifest.fonts.is_empty() {
        return Err("The packaged-font capability does not match the font manifest.".to_string());
    }
    let mut font_identities = HashSet::new();
    let mut face_descriptors = HashSet::new();
    let mut font_paths = HashSet::new();
    for font in &manifest.fonts {
        validate_archive_path(&font.path)?;
        if !font.path.starts_with(".typstella/fonts/package/") {
            return Err(format!(
                "Packaged font path '{}' is outside the font package.",
                font.path
            ));
        }
        if !font.license.redistributable {
            return Err(format!(
                "Packaged font '{}' is not redistributable.",
                font.postscript_name
            ));
        }
        if !matches!(font.format.as_str(), "ttf" | "otf" | "ttc") {
            return Err(format!(
                "Packaged font '{}' has an unsupported format.",
                font.postscript_name
            ));
        }
        let expected = manifest.integrity.files.get(&font.path).ok_or_else(|| {
            format!(
                "Packaged font '{}' is missing from integrity.files.",
                font.postscript_name
            )
        })?;
        if expected != &font.sha256 {
            return Err(format!(
                "Packaged font '{}' has inconsistent hashes.",
                font.postscript_name
            ));
        }
        let identity = format!(
            "{}#{}",
            font.postscript_name.to_lowercase(),
            font.face_index
        );
        let descriptor = format!(
            "{}|{}|{}|{}",
            font.family.to_lowercase(),
            font.style.to_lowercase(),
            font.weight,
            font.stretch
        );
        if !font_identities.insert(identity)
            || !face_descriptors.insert(descriptor)
            || !font_paths.insert(font.path.to_lowercase())
        {
            return Err(format!(
                "Duplicate packaged font identity '{}'.",
                font.postscript_name
            ));
        }
    }
    Ok(())
}

pub fn inspect_typstella_project(archive_path: &Path) -> Result<ArchiveInspection, String> {
    let file = open_archive_file(archive_path)?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|error| format!("The selected file is not a valid ZIP archive: {error}"))?;
    Ok(validate_open_archive(&mut archive)?.inspection)
}

#[allow(dead_code)]
pub fn import_typstella_project(
    archive_path: &Path,
    destination_path: &Path,
    expected_manifest_sha256: &str,
) -> Result<ImportedProject, String> {
    import_typstella_project_cancellable(
        archive_path,
        destination_path,
        expected_manifest_sha256,
        || false,
    )
}

pub fn import_typstella_project_cancellable(
    archive_path: &Path,
    destination_path: &Path,
    expected_manifest_sha256: &str,
    should_cancel: impl Fn() -> bool,
) -> Result<ImportedProject, String> {
    let file = open_archive_file(archive_path)?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|error| format!("The selected file is not a valid ZIP archive: {error}"))?;
    let validated = validate_open_archive(&mut archive)?;
    if validated.inspection.manifest_sha256 != expected_manifest_sha256 {
        return Err(
            "The project archive changed after inspection. Select the archive again.".to_string(),
        );
    }

    let parent_input = destination_path.parent().ok_or_else(|| {
        format!(
            "The import destination '{}' has no parent directory.",
            destination_path.display()
        )
    })?;
    let destination_name = destination_path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "The import destination name is not valid Unicode.".to_string())?;
    validate_portable_component(destination_name)?;
    let parent = std::fs::canonicalize(parent_input).map_err(|error| {
        format!(
            "Failed to resolve import destination '{}': {error}",
            parent_input.display()
        )
    })?;
    if !parent.is_dir() {
        return Err("The import destination parent is not a directory.".to_string());
    }
    let destination = parent.join(destination_name);
    if destination.exists() {
        return Err(format!(
            "The import destination already exists: '{}'. Choose another location.",
            destination.display()
        ));
    }

    let staging = tempfile::Builder::new()
        .prefix(".typstella-import-")
        .tempdir_in(&parent)
        .map_err(|error| format!("Failed to create import staging directory: {error}"))?;
    let mut extracted_files = HashSet::new();
    for metadata in &validated.entries {
        if should_cancel() {
            return Err("Project import cancelled.".to_string());
        }
        let target = join_archive_path(staging.path(), &metadata.path);
        if metadata.is_directory {
            std::fs::create_dir_all(&target).map_err(|error| {
                format!(
                    "Failed to create imported directory '{}': {error}",
                    target.display()
                )
            })?;
            continue;
        }
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|error| {
                format!(
                    "Failed to create imported directory '{}': {error}",
                    parent.display()
                )
            })?;
        }
        let mut entry = archive.by_index(metadata.index).map_err(|error| {
            format!(
                "Failed to reopen archive entry '{}': {error}",
                metadata.path
            )
        })?;
        let mut output = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
            .map_err(|error| {
                format!(
                    "Failed to create imported file '{}': {error}",
                    target.display()
                )
            })?;
        let mut hasher = Sha256::new();
        let mut written = 0_u64;
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            if should_cancel() {
                return Err("Project import cancelled.".to_string());
            }
            let count = entry.read(&mut buffer).map_err(|error| {
                format!("Failed to read archive entry '{}': {error}", metadata.path)
            })?;
            if count == 0 {
                break;
            }
            written = written
                .checked_add(count as u64)
                .ok_or_else(|| format!("Archive entry '{}' is too large.", metadata.path))?;
            if written > metadata.size || written > MAX_ENTRY_BYTES {
                return Err(format!(
                    "Archive entry '{}' expanded beyond its declared size.",
                    metadata.path
                ));
            }
            hasher.update(&buffer[..count]);
            output.write_all(&buffer[..count]).map_err(|error| {
                format!(
                    "Failed to write imported file '{}': {error}",
                    target.display()
                )
            })?;
        }
        if written != metadata.size {
            return Err(format!(
                "Archive entry '{}' did not match its declared size.",
                metadata.path
            ));
        }
        if metadata.path != PROJECT_MANIFEST_PATH {
            let expected = validated
                .inspection
                .manifest
                .integrity
                .files
                .get(&metadata.path)
                .ok_or_else(|| {
                    format!(
                        "Archive entry '{}' is not declared by the manifest.",
                        metadata.path
                    )
                })?;
            let actual = format!("{:x}", hasher.finalize());
            if &actual != expected {
                return Err(format!(
                    "Integrity verification failed for '{}'. The project was not imported.",
                    metadata.path
                ));
            }
            extracted_files.insert(metadata.path.clone());
        }
    }
    let declared_files = validated
        .inspection
        .manifest
        .integrity
        .files
        .keys()
        .cloned()
        .collect::<HashSet<_>>();
    if extracted_files != declared_files {
        return Err("The archive contents do not match the integrity manifest.".to_string());
    }
    if should_cancel() {
        return Err("Project import cancelled.".to_string());
    }

    let staged_path = staging.keep();
    if let Err(error) = std::fs::rename(&staged_path, &destination) {
        let _ = std::fs::remove_dir_all(&staged_path);
        return Err(format!(
            "Failed to activate imported project '{}': {error}",
            destination.display()
        ));
    }
    let display_destination = dunce::simplified(&destination).to_path_buf();
    let main_file = join_archive_path(
        &display_destination,
        &validated.inspection.manifest.project.main,
    );
    Ok(ImportedProject {
        workspace_path: display_destination.to_string_lossy().to_string(),
        main_file_path: main_file.to_string_lossy().to_string(),
        manifest: validated.inspection.manifest,
    })
}

pub fn export_source_zip(workspace_root: &Path, archive_path: &Path) -> Result<(), String> {
    let root = canonical_workspace_root(workspace_root)?;
    let excluded_output = canonicalize_if_exists(archive_path);
    let files = collect_workspace_files(&root, excluded_output.as_deref())?;
    write_archive(archive_path, |writer| write_snapshots(writer, &files))
}

pub fn export_typstella_project(options: ProjectExport<'_>) -> Result<ProjectManifest, String> {
    require_extension(options.archive_path, "typstella")?;
    let root = canonical_workspace_root(options.workspace_root)?;
    let main = std::fs::canonicalize(options.main_file_path).map_err(|error| {
        format!(
            "Failed to resolve project main file '{}': {error}",
            options.main_file_path.display()
        )
    })?;
    if !main.is_file() || main.extension().and_then(|value| value.to_str()) != Some("typ") {
        return Err("The project main file must be an existing .typ file.".to_string());
    }
    let main_relative = archive_path_for(&root, &main)?;
    let excluded_output = canonicalize_if_exists(options.archive_path);
    let mut files = collect_workspace_files(&root, excluded_output.as_deref())?;
    let packaged_fonts = options.packaged_fonts.unwrap_or_default();
    for font in &packaged_fonts {
        validate_archive_path(&font.path)?;
        if !font.path.starts_with(".typstella/fonts/package/") || !font.license.redistributable {
            return Err(format!(
                "Font {:?} is not a valid redistributable package asset.",
                font.postscript_name
            ));
        }
        let absolute_path = join_archive_path(&root, &font.path);
        let bytes = read_stable_file(&absolute_path)?;
        let actual = sha256_hex(&bytes);
        if actual != font.sha256 {
            return Err(format!(
                "Packaged font {:?} changed before export.",
                font.postscript_name
            ));
        }
        files.push(FileSnapshot {
            absolute_path,
            archive_path: font.path.clone(),
            sha256: actual,
        });
    }
    files.sort_by(|left, right| left.archive_path.cmp(&right.archive_path));
    if !files.iter().any(|file| file.archive_path == main_relative) {
        return Err("The project main file was excluded from the archive.".to_string());
    }

    let project_name = root
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "The workspace folder does not have a valid Unicode name.".to_string())?
        .to_string();
    let integrity_files = files
        .iter()
        .map(|file| (file.archive_path.clone(), file.sha256.clone()))
        .collect();
    let manifest = ProjectManifest {
        format: PROJECT_FORMAT.to_string(),
        schema_version: PROJECT_SCHEMA_VERSION,
        created_by: CreatedBy {
            application: "Typstella".to_string(),
            version: options.app_version.to_string(),
        },
        project: ProjectIdentity {
            name: project_name,
            main: main_relative,
        },
        toolchain: ProjectToolchain {
            typst_version: options.typst_version.to_string(),
            tinymist_version: options.tinymist_version.to_string(),
            compatibility: ToolchainCompatibility::Exact,
        },
        // V1-I.18 through V1-I.24 will replace this explicit capability marker with
        // the verified project-local font payload. Do not infer full render
        // reproducibility while it remains false.
        render_environment: RenderEnvironment {
            fonts_packaged: !packaged_fonts.is_empty(),
        },
        fonts: packaged_fonts,
        integrity: ProjectIntegrity {
            algorithm: "sha256".to_string(),
            files: integrity_files,
        },
    };
    validate_manifest_compatibility(&manifest)?;
    let mut manifest_bytes = serde_json::to_vec_pretty(&manifest)
        .map_err(|error| format!("Failed to serialize project manifest: {error}"))?;
    manifest_bytes.push(b'\n');

    write_archive(options.archive_path, |writer| {
        write_entry(writer, PROJECT_MANIFEST_PATH, &manifest_bytes)?;
        write_snapshots(writer, &files)
    })?;
    Ok(manifest)
}

fn open_archive_file(path: &Path) -> Result<File, String> {
    require_extension(path, "typstella")?;
    let metadata = std::fs::metadata(path).map_err(|error| {
        format!(
            "Failed to inspect project archive '{}': {error}",
            path.display()
        )
    })?;
    if !metadata.is_file() {
        return Err("The selected project archive is not a file.".to_string());
    }
    if metadata.len() > MAX_ARCHIVE_BYTES {
        return Err(format!(
            "The project archive is larger than the {} MiB limit.",
            MAX_ARCHIVE_BYTES / 1024 / 1024
        ));
    }
    File::open(path).map_err(|error| {
        format!(
            "Failed to open project archive '{}': {error}",
            path.display()
        )
    })
}

fn validate_open_archive(file: &mut zip::ZipArchive<File>) -> Result<ValidatedArchive, String> {
    if file.len() == 0 || file.len() > MAX_ARCHIVE_ENTRIES {
        return Err(format!(
            "The project archive must contain between 1 and {MAX_ARCHIVE_ENTRIES} entries."
        ));
    }
    let mut entries = Vec::with_capacity(file.len());
    let mut normalized_paths = HashSet::new();
    let mut manifest_index = None;
    let mut total_uncompressed = 0_u64;

    for index in 0..file.len() {
        let entry = file
            .by_index(index)
            .map_err(|error| format!("Failed to inspect archive entry {index}: {error}"))?;
        if entry.encrypted() {
            return Err(format!(
                "Encrypted archive entries are not supported: '{}'.",
                entry.name()
            ));
        }
        let raw_name = std::str::from_utf8(entry.name_raw()).map_err(|_| {
            "The project archive contains a filename that is not UTF-8.".to_string()
        })?;
        let is_directory = entry.is_dir();
        let path = if is_directory {
            raw_name.trim_end_matches('/')
        } else {
            raw_name
        };
        validate_archive_path(path)?;
        validate_portable_archive_path(path)?;
        if path.as_bytes().len() > MAX_PATH_BYTES {
            return Err(format!(
                "Archive path exceeds {MAX_PATH_BYTES} bytes: '{path}'."
            ));
        }
        let normalized = normalized_archive_key(path);
        if !normalized_paths.insert(normalized) {
            return Err(format!(
                "The archive contains duplicate or cross-platform-colliding paths: '{path}'."
            ));
        }
        let size = entry.size();
        let compressed_size = entry.compressed_size();
        if size > MAX_ENTRY_BYTES {
            return Err(format!(
                "Archive entry '{}' exceeds the {} MiB per-file limit.",
                path,
                MAX_ENTRY_BYTES / 1024 / 1024
            ));
        }
        total_uncompressed = total_uncompressed
            .checked_add(size)
            .ok_or_else(|| "The archive's uncompressed size overflowed.".to_string())?;
        if total_uncompressed > MAX_TOTAL_UNCOMPRESSED_BYTES {
            return Err(format!(
                "The archive exceeds the {} MiB uncompressed-size limit.",
                MAX_TOTAL_UNCOMPRESSED_BYTES / 1024 / 1024
            ));
        }
        if size > 1024 * 1024
            && (compressed_size == 0 || size / compressed_size.max(1) > MAX_COMPRESSION_RATIO)
        {
            return Err(format!(
                "Archive entry '{}' has an unsafe compression ratio.",
                path
            ));
        }
        validate_unix_entry_type(entry.unix_mode(), is_directory, path)?;
        if path == PROJECT_MANIFEST_PATH {
            if is_directory || manifest_index.replace(index).is_some() {
                return Err(
                    "The archive must contain exactly one project manifest file.".to_string(),
                );
            }
            if size > MAX_MANIFEST_BYTES {
                return Err("The project manifest is larger than 1 MiB.".to_string());
            }
        }
        entries.push(ValidatedArchiveEntry {
            index,
            path: path.to_string(),
            is_directory,
            size,
        });
    }

    let manifest_index = manifest_index
        .ok_or_else(|| format!("The archive does not contain '{PROJECT_MANIFEST_PATH}'."))?;
    let mut manifest_entry = file
        .by_index(manifest_index)
        .map_err(|error| format!("Failed to read project manifest: {error}"))?;
    let mut manifest_bytes = Vec::with_capacity(manifest_entry.size() as usize);
    manifest_entry
        .read_to_end(&mut manifest_bytes)
        .map_err(|error| format!("Failed to read project manifest: {error}"))?;
    drop(manifest_entry);
    if manifest_bytes.len() as u64 > MAX_MANIFEST_BYTES {
        return Err("The project manifest is larger than 1 MiB.".to_string());
    }
    let manifest: ProjectManifest = serde_json::from_slice(&manifest_bytes)
        .map_err(|error| format!("The project manifest is invalid JSON: {error}"))?;
    validate_manifest_compatibility(&manifest)?;
    let font_paths = manifest
        .fonts
        .iter()
        .map(|font| font.path.as_str())
        .collect::<HashSet<_>>();
    let mut total_font_bytes = 0_u64;
    for entry in &entries {
        if font_paths.contains(entry.path.as_str()) {
            if entry.size > MAX_PACKAGED_FONT_BYTES {
                return Err(format!(
                    "Packaged font '{}' exceeds the 64 MiB limit.",
                    entry.path
                ));
            }
            total_font_bytes = total_font_bytes.saturating_add(entry.size);
        }
    }
    if total_font_bytes > MAX_TOTAL_PACKAGED_FONT_BYTES {
        return Err("The packaged fonts exceed the 256 MiB total limit.".to_string());
    }
    for font in &manifest.fonts {
        let metadata = entries
            .iter()
            .find(|entry| entry.path == font.path)
            .ok_or_else(|| {
                format!(
                    "Packaged font '{}' is missing from the archive.",
                    font.postscript_name
                )
            })?;
        let mut entry = file.by_index(metadata.index).map_err(|error| {
            format!(
                "Failed to inspect packaged font '{}': {error}",
                font.postscript_name
            )
        })?;
        let mut bytes = Vec::with_capacity(entry.size() as usize);
        entry.read_to_end(&mut bytes).map_err(|error| {
            format!(
                "Failed to read packaged font '{}': {error}",
                font.postscript_name
            )
        })?;
        crate::project_fonts::validate_packaged_font_bytes(
            &bytes,
            font.face_index,
            &font.sha256,
            &font.postscript_name,
        )?;
    }

    let archive_files = entries
        .iter()
        .filter(|entry| !entry.is_directory && entry.path != PROJECT_MANIFEST_PATH)
        .map(|entry| entry.path.as_str())
        .collect::<HashSet<_>>();
    let declared_files = manifest
        .integrity
        .files
        .keys()
        .map(String::as_str)
        .collect::<HashSet<_>>();
    if archive_files != declared_files {
        return Err(
            "The archive file list does not exactly match integrity.files in the manifest."
                .to_string(),
        );
    }

    Ok(ValidatedArchive {
        inspection: ArchiveInspection {
            manifest_sha256: sha256_hex(&manifest_bytes),
            entry_count: entries.len(),
            total_uncompressed_bytes: total_uncompressed,
            suggested_folder_name: manifest.project.name.clone(),
            manifest,
        },
        entries,
    })
}

fn normalized_archive_key(path: &str) -> String {
    path.nfc().collect::<String>().to_lowercase()
}

fn validate_unix_entry_type(
    mode: Option<u32>,
    is_directory: bool,
    path: &str,
) -> Result<(), String> {
    if let Some(mode) = mode {
        let kind = mode & 0o170000;
        let expected = if is_directory { 0o040000 } else { 0o100000 };
        if kind != 0 && kind != expected {
            return Err(format!(
                "Archive entry '{}' is a symbolic link or unsupported special file.",
                path
            ));
        }
    }
    Ok(())
}

fn validate_portable_archive_path(path: &str) -> Result<(), String> {
    for component in path.split('/') {
        validate_portable_component(component)?;
    }
    Ok(())
}

fn validate_portable_component(component: &str) -> Result<(), String> {
    if component.trim().is_empty()
        || component.ends_with(' ')
        || component.ends_with('.')
        || component.chars().any(|value| value.is_control())
        || component.contains(['<', '>', ':', '"', '/', '\\', '|', '?', '*'])
    {
        return Err(format!("Path component is not portable: '{component}'."));
    }
    let stem = component
        .split('.')
        .next()
        .unwrap_or(component)
        .to_ascii_uppercase();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.as_bytes()[3].is_ascii_digit()
            && stem.as_bytes()[3] != b'0');
    if reserved {
        return Err(format!(
            "Path component uses a reserved Windows name: '{component}'."
        ));
    }
    Ok(())
}

fn join_archive_path(root: &Path, path: &str) -> PathBuf {
    let mut result = root.to_path_buf();
    for component in path.split('/') {
        result.push(component);
    }
    result
}

fn canonical_workspace_root(workspace_root: &Path) -> Result<PathBuf, String> {
    let root = std::fs::canonicalize(workspace_root).map_err(|error| {
        format!(
            "Failed to resolve workspace '{}': {error}",
            workspace_root.display()
        )
    })?;
    if !root.is_dir() {
        return Err("Workspace path is not a directory.".to_string());
    }
    Ok(root)
}

fn canonicalize_if_exists(path: &Path) -> Option<PathBuf> {
    path.exists()
        .then(|| std::fs::canonicalize(path).ok())
        .flatten()
}

fn collect_workspace_files(
    root: &Path,
    excluded_output: Option<&Path>,
) -> Result<Vec<FileSnapshot>, String> {
    let mut files = Vec::new();
    collect_directory(root, root, excluded_output, &mut files)?;
    files.sort_by(|left, right| left.archive_path.cmp(&right.archive_path));
    let mut seen = HashSet::new();
    for file in &files {
        let comparison_key = file.archive_path.to_lowercase();
        if !seen.insert(comparison_key) {
            return Err(format!(
                "The workspace contains archive paths that collide across platforms: '{}'.",
                file.archive_path
            ));
        }
    }
    Ok(files)
}

fn collect_directory(
    root: &Path,
    directory: &Path,
    excluded_output: Option<&Path>,
    files: &mut Vec<FileSnapshot>,
) -> Result<(), String> {
    let mut entries = std::fs::read_dir(directory)
        .map_err(|error| {
            format!(
                "Failed to read directory '{}': {error}",
                directory.display()
            )
        })?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Failed to enumerate '{}': {error}", directory.display()))?;
    entries.sort_by_key(|entry| entry.file_name());

    for entry in entries {
        let path = entry.path();
        let file_type = entry
            .file_type()
            .map_err(|error| format!("Failed to inspect '{}': {error}", path.display()))?;
        if file_type.is_symlink() {
            return Err(format!(
                "Symbolic links are not supported in project exports: '{}'.",
                path.display()
            ));
        }
        if file_type.is_dir() {
            let name = entry.file_name();
            let name = name.to_str().ok_or_else(|| {
                format!(
                    "A workspace directory name is not valid Unicode: '{:?}'.",
                    name
                )
            })?;
            if is_excluded_directory(name) {
                continue;
            }
            collect_directory(root, &path, excluded_output, files)?;
        } else if file_type.is_file() {
            if excluded_output.is_some_and(|output| path == output) {
                continue;
            }
            let archive_path = archive_path_for(root, &path)?;
            validate_archive_path(&archive_path)?;
            let bytes = read_stable_file(&path)?;
            files.push(FileSnapshot {
                absolute_path: path,
                archive_path,
                sha256: sha256_hex(&bytes),
            });
        } else {
            return Err(format!(
                "Unsupported workspace entry type: '{}'.",
                path.display()
            ));
        }
    }
    Ok(())
}

fn is_excluded_directory(name: &str) -> bool {
    matches!(name, ".git" | ".typstella" | "node_modules" | "target")
}

fn archive_path_for(root: &Path, path: &Path) -> Result<String, String> {
    let relative = path.strip_prefix(root).map_err(|_| {
        format!(
            "Project file '{}' is outside workspace '{}'.",
            path.display(),
            root.display()
        )
    })?;
    let components = relative
        .components()
        .map(|component| {
            component.as_os_str().to_str().ok_or_else(|| {
                format!(
                    "A workspace path is not valid Unicode: '{}'.",
                    path.display()
                )
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(components.join("/"))
}

fn validate_archive_path(path: &str) -> Result<(), String> {
    if path.is_empty()
        || path.starts_with('/')
        || path.starts_with('\\')
        || path.contains('\\')
        || path
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err(format!("Invalid project archive path: '{path}'."));
    }
    Ok(())
}

fn require_extension(path: &Path, expected: &str) -> Result<(), String> {
    let actual = path.extension().and_then(|value| value.to_str());
    if actual.is_some_and(|value| value.eq_ignore_ascii_case(expected)) {
        Ok(())
    } else {
        Err(format!(
            "Typstella project exports must use the .{expected} extension."
        ))
    }
}

fn read_stable_file(path: &Path) -> Result<Vec<u8>, String> {
    let before = std::fs::metadata(path)
        .map_err(|error| format!("Failed to inspect '{}': {error}", path.display()))?;
    let mut file = File::open(path)
        .map_err(|error| format!("Failed to open '{}': {error}", path.display()))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|error| format!("Failed to read '{}': {error}", path.display()))?;
    let after = file
        .metadata()
        .map_err(|error| format!("Failed to recheck '{}': {error}", path.display()))?;
    if before.len() != after.len()
        || before.modified().ok() != after.modified().ok()
        || after.len() != bytes.len() as u64
    {
        return Err(format!(
            "Project file changed during export: '{}'. Save it and retry.",
            path.display()
        ));
    }
    Ok(bytes)
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn deterministic_file_options() -> FileOptions<'static, ()> {
    FileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .last_modified_time(zip::DateTime::default())
        .unix_permissions(0o644)
}

fn write_archive(
    archive_path: &Path,
    write_contents: impl FnOnce(&mut zip::ZipWriter<File>) -> Result<(), String>,
) -> Result<(), String> {
    let parent = archive_path
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    std::fs::create_dir_all(parent).map_err(|error| {
        format!(
            "Failed to create export directory '{}': {error}",
            parent.display()
        )
    })?;
    let temporary = tempfile::NamedTempFile::new_in(parent)
        .map_err(|error| format!("Failed to stage project export: {error}"))?;
    let file = temporary
        .reopen()
        .map_err(|error| format!("Failed to open staged project export: {error}"))?;
    let mut writer = zip::ZipWriter::new(file);
    write_contents(&mut writer)?;
    writer
        .finish()
        .map_err(|error| format!("Failed to finish project archive: {error}"))?;
    temporary.persist(archive_path).map_err(|error| {
        format!(
            "Failed to publish project export '{}': {}",
            archive_path.display(),
            error.error
        )
    })?;
    Ok(())
}

fn write_snapshots(
    writer: &mut zip::ZipWriter<File>,
    files: &[FileSnapshot],
) -> Result<(), String> {
    for snapshot in files {
        let bytes = read_stable_file(&snapshot.absolute_path)?;
        let actual_hash = sha256_hex(&bytes);
        if actual_hash != snapshot.sha256 {
            return Err(format!(
                "Project file changed during export: '{}'. Save it and retry.",
                snapshot.absolute_path.display()
            ));
        }
        write_entry(writer, &snapshot.archive_path, &bytes)?;
    }
    Ok(())
}

fn write_entry<W: Write + Seek>(
    writer: &mut zip::ZipWriter<W>,
    path: &str,
    bytes: &[u8],
) -> Result<(), String> {
    writer
        .start_file(path, deterministic_file_options())
        .map_err(|error| format!("Failed to add '{path}' to project archive: {error}"))?;
    writer
        .write_all(bytes)
        .map_err(|error| format!("Failed to write '{path}' to project archive: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    fn create_workspace() -> tempfile::TempDir {
        let workspace = tempfile::tempdir().unwrap();
        std::fs::write(workspace.path().join("main.typ"), "= Hello\n").unwrap();
        std::fs::create_dir(workspace.path().join("chapters")).unwrap();
        std::fs::write(workspace.path().join("chapters").join("ខ្មែរ.typ"), "= ខ្មែរ\n").unwrap();
        std::fs::create_dir(workspace.path().join(".typstella")).unwrap();
        std::fs::write(
            workspace.path().join(".typstella").join("cache.txt"),
            "skip",
        )
        .unwrap();
        workspace
    }

    fn export_project(workspace: &Path, destination: &Path) -> ProjectManifest {
        export_typstella_project(ProjectExport {
            workspace_root: workspace,
            archive_path: destination,
            main_file_path: &workspace.join("main.typ"),
            app_version: "1.0.0",
            typst_version: "0.13.1",
            tinymist_version: "0.13.10",
            packaged_fonts: None,
        })
        .unwrap()
    }

    fn write_custom_archive(path: &Path, entries: &[(&str, &[u8], Option<u32>)]) {
        let file = File::create(path).unwrap();
        let mut writer = zip::ZipWriter::new(file);
        for (name, bytes, permissions) in entries {
            let mut options = deterministic_file_options();
            if let Some(permissions) = permissions {
                options = options.unix_permissions(*permissions);
            }
            writer.start_file(*name, options).unwrap();
            writer.write_all(bytes).unwrap();
        }
        writer.finish().unwrap();
    }

    #[test]
    fn project_manifest_round_trips_and_validates() {
        let workspace = create_workspace();
        let output = tempfile::tempdir().unwrap();
        let archive = output.path().join("manifest-test.typstella");
        let manifest = export_project(workspace.path(), &archive);
        let encoded = serde_json::to_string(&manifest).unwrap();
        let decoded: ProjectManifest = serde_json::from_str(&encoded).unwrap();
        assert_eq!(decoded, manifest);
        assert!(validate_manifest_compatibility(&decoded).is_ok());
        assert_eq!(decoded.project.main, "main.typ");
        assert_eq!(decoded.toolchain.typst_version, "0.13.1");
        assert!(!decoded.render_environment.fonts_packaged);
    }

    #[test]
    fn cancelled_import_never_promotes_destination() {
        let workspace = create_workspace();
        let output = tempfile::tempdir().unwrap();
        let archive = output.path().join("cancel.typstella");
        export_project(workspace.path(), &archive);
        let inspection = inspect_typstella_project(&archive).unwrap();
        let destination = output.path().join("cancelled-project");

        let error = import_typstella_project_cancellable(
            &archive,
            &destination,
            &inspection.manifest_sha256,
            || true,
        )
        .unwrap_err();

        assert_eq!(error, "Project import cancelled.");
        assert!(!destination.exists());
        assert!(std::fs::read_dir(output.path()).unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".typstella-import-")));
    }

    #[test]
    fn invalid_schema_versions_paths_and_hashes_are_rejected() {
        let workspace = create_workspace();
        let output = tempfile::tempdir().unwrap();
        let archive = output.path().join("validation.typstella");
        let manifest = export_project(workspace.path(), &archive);

        let mut invalid = manifest.clone();
        invalid.schema_version += 1;
        assert!(validate_manifest_compatibility(&invalid).is_err());

        let mut invalid = manifest.clone();
        invalid.project.main = "../main.typ".to_string();
        assert!(validate_manifest_compatibility(&invalid).is_err());

        let mut invalid = manifest;
        invalid
            .integrity
            .files
            .insert("main.typ".to_string(), "invalid".to_string());
        assert!(validate_manifest_compatibility(&invalid).is_err());
    }

    #[test]
    fn font_manifest_rejects_restricted_missing_and_duplicate_identities() {
        let workspace = create_workspace();
        let output = tempfile::tempdir().unwrap();
        let archive = output.path().join("fonts.typstella");
        let mut manifest = export_project(workspace.path(), &archive);
        let path = ".typstella/fonts/package/test.ttf".to_string();
        let hash = "a".repeat(64);
        let font = ProjectFont {
            id: "Test-Regular:0".into(),
            family: "Test".into(),
            postscript_name: "Test-Regular".into(),
            style: "normal".into(),
            weight: 400,
            stretch: 100,
            path: path.clone(),
            sha256: hash.clone(),
            face_index: 0,
            format: "ttf".into(),
            variable: false,
            source: "system".into(),
            license: ProjectFontLicense {
                name: "OFL-1.1".into(),
                redistributable: true,
                modifiable: true,
            },
        };
        manifest.render_environment.fonts_packaged = true;
        manifest.fonts.push(font.clone());
        assert!(validate_manifest_compatibility(&manifest).is_err());
        manifest.integrity.files.insert(path, hash);
        assert!(validate_manifest_compatibility(&manifest).is_ok());
        manifest.fonts.push(font);
        assert!(validate_manifest_compatibility(&manifest).is_err());
        manifest.fonts.pop();
        manifest.fonts[0].license.redistributable = false;
        assert!(validate_manifest_compatibility(&manifest).is_err());
    }

    #[test]
    fn export_is_sorted_unicode_safe_and_excludes_generated_directories() {
        let workspace = create_workspace();
        let output = tempfile::tempdir().unwrap();
        let archive = output.path().join("unicode-test.typstella");
        export_project(workspace.path(), &archive);
        let file = File::open(&archive).unwrap();
        let mut zip = zip::ZipArchive::new(file).unwrap();
        let names = (0..zip.len())
            .map(|index| zip.by_index(index).unwrap().name().to_string())
            .collect::<Vec<_>>();
        assert_eq!(names[0], PROJECT_MANIFEST_PATH);
        assert!(names.contains(&"chapters/ខ្មែរ.typ".to_string()));
        assert!(!names.iter().any(|name| name.contains("cache.txt")));
    }

    #[test]
    fn manifest_hashes_match_archive_contents() {
        let workspace = create_workspace();
        let output = tempfile::tempdir().unwrap();
        let archive = output.path().join("hash-test.typstella");
        let manifest = export_project(workspace.path(), &archive);
        let file = File::open(&archive).unwrap();
        let mut zip = zip::ZipArchive::new(file).unwrap();
        for (name, expected_hash) in manifest.integrity.files {
            let mut entry = zip.by_name(&name).unwrap();
            let mut bytes = Vec::new();
            entry.read_to_end(&mut bytes).unwrap();
            assert_eq!(sha256_hex(&bytes), expected_hash);
        }
    }

    #[test]
    fn identical_inputs_produce_identical_archives() {
        let workspace = create_workspace();
        let output = tempfile::tempdir().unwrap();
        let first = output.path().join("deterministic-a.typstella");
        let second = output.path().join("deterministic-b.typstella");
        export_project(workspace.path(), &first);
        export_project(workspace.path(), &second);
        assert_eq!(
            std::fs::read(&first).unwrap(),
            std::fs::read(&second).unwrap()
        );
    }

    #[test]
    fn source_zip_has_no_manifest_and_replaces_existing_destination() {
        let workspace = create_workspace();
        let output = tempfile::tempdir().unwrap();
        let archive = output.path().join("source.zip");
        std::fs::write(&archive, "old").unwrap();
        export_source_zip(workspace.path(), &archive).unwrap();
        let file = File::open(&archive).unwrap();
        let mut zip = zip::ZipArchive::new(file).unwrap();
        assert!(zip.by_name("main.typ").is_ok());
        assert!(zip.by_name(PROJECT_MANIFEST_PATH).is_err());
    }

    #[test]
    fn changed_snapshot_is_rejected_before_archive_publication() {
        let workspace = create_workspace();
        let files = collect_workspace_files(workspace.path(), None).unwrap();
        std::fs::write(workspace.path().join("main.typ"), "= Changed\n").unwrap();
        let output = tempfile::tempdir().unwrap();
        let archive = output.path().join("changed.zip");
        let error = write_archive(&archive, |writer| write_snapshots(writer, &files)).unwrap_err();
        assert!(error.contains("changed during export"));
        assert!(!archive.exists());
    }

    #[test]
    fn preflight_and_transactional_import_succeed() {
        let workspace = create_workspace();
        let output = tempfile::tempdir().unwrap();
        let archive = output.path().join("valid.typstella");
        export_project(workspace.path(), &archive);
        let inspection = inspect_typstella_project(&archive).unwrap();
        let destination = output.path().join("imported-project");
        let imported =
            import_typstella_project(&archive, &destination, &inspection.manifest_sha256).unwrap();
        assert_eq!(Path::new(&imported.workspace_path), destination);
        assert!(destination.join("main.typ").is_file());
        assert!(destination.join("chapters").join("ខ្មែរ.typ").is_file());
        assert!(!destination.join(".typstella").join("cache.txt").exists());
        assert!(destination.join(PROJECT_MANIFEST_PATH).is_file());
    }

    #[test]
    fn preflight_rejects_traversal_collisions_and_symlinks() {
        let output = tempfile::tempdir().unwrap();

        let traversal = output.path().join("traversal.typstella");
        write_custom_archive(&traversal, &[("../outside.typ", b"bad", None)]);
        assert!(inspect_typstella_project(&traversal)
            .unwrap_err()
            .contains("Invalid project archive path"));

        let collision = output.path().join("collision.typstella");
        write_custom_archive(
            &collision,
            &[("Main.typ", b"one", None), ("main.typ", b"two", None)],
        );
        assert!(inspect_typstella_project(&collision)
            .unwrap_err()
            .contains("colliding paths"));

        assert!(validate_unix_entry_type(Some(0o120777), false, "link.typ")
            .unwrap_err()
            .contains("symbolic link"));

        let unicode_collision = output.path().join("unicode-collision.typstella");
        write_custom_archive(
            &unicode_collision,
            &[("é.typ", b"one", None), ("e\u{301}.typ", b"two", None)],
        );
        assert!(inspect_typstella_project(&unicode_collision)
            .unwrap_err()
            .contains("colliding paths"));

        let reserved = output.path().join("reserved.typstella");
        write_custom_archive(&reserved, &[("CON.typ", b"bad", None)]);
        assert!(inspect_typstella_project(&reserved)
            .unwrap_err()
            .contains("reserved Windows name"));
    }

    #[test]
    fn preflight_rejects_zip_bomb_compression_ratio() {
        let output = tempfile::tempdir().unwrap();
        let archive = output.path().join("ratio.typstella");
        let zeros = vec![0_u8; 2 * 1024 * 1024];
        write_custom_archive(&archive, &[("large.bin", &zeros, None)]);
        assert!(inspect_typstella_project(&archive)
            .unwrap_err()
            .contains("unsafe compression ratio"));
    }

    #[test]
    fn failed_integrity_leaves_no_destination() {
        let output = tempfile::tempdir().unwrap();
        let archive = output.path().join("bad-hash.typstella");
        let mut files = BTreeMap::new();
        files.insert("main.typ".to_string(), sha256_hex(b"expected"));
        let manifest = ProjectManifest {
            format: PROJECT_FORMAT.to_string(),
            schema_version: PROJECT_SCHEMA_VERSION,
            created_by: CreatedBy {
                application: "Typstella".to_string(),
                version: "1.0.0".to_string(),
            },
            project: ProjectIdentity {
                name: "imported-project".to_string(),
                main: "main.typ".to_string(),
            },
            toolchain: ProjectToolchain {
                typst_version: "0.13.1".to_string(),
                tinymist_version: "0.13.10".to_string(),
                compatibility: ToolchainCompatibility::Exact,
            },
            render_environment: RenderEnvironment {
                fonts_packaged: false,
            },
            fonts: vec![],
            integrity: ProjectIntegrity {
                algorithm: "sha256".to_string(),
                files,
            },
        };
        let manifest_bytes = serde_json::to_vec_pretty(&manifest).unwrap();
        write_custom_archive(
            &archive,
            &[
                (PROJECT_MANIFEST_PATH, &manifest_bytes, None),
                ("main.typ", b"tampered", None),
            ],
        );
        let inspection = inspect_typstella_project(&archive).unwrap();
        let destination = output.path().join("imported-project");
        let error = import_typstella_project(&archive, &destination, &inspection.manifest_sha256)
            .unwrap_err();
        assert!(error.contains("Integrity verification failed"));
        assert!(!destination.exists());
        assert!(!output
            .path()
            .read_dir()
            .unwrap()
            .filter_map(Result::ok)
            .any(|entry| entry
                .file_name()
                .to_string_lossy()
                .starts_with(".typstella-import-")));
    }

    #[test]
    fn changed_archive_and_existing_destination_are_rejected() {
        let workspace = create_workspace();
        let output = tempfile::tempdir().unwrap();
        let archive = output.path().join("checked.typstella");
        export_project(workspace.path(), &archive);
        let inspection = inspect_typstella_project(&archive).unwrap();
        let destination = output.path().join("existing");
        std::fs::create_dir(&destination).unwrap();
        assert!(
            import_typstella_project(&archive, &destination, &inspection.manifest_sha256,)
                .unwrap_err()
                .contains("already exists")
        );
        assert!(
            import_typstella_project(&archive, &output.path().join("other"), "0")
                .unwrap_err()
                .contains("changed after inspection")
        );
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_are_rejected() {
        use std::os::unix::fs::symlink;
        let workspace = create_workspace();
        symlink(
            workspace.path().join("main.typ"),
            workspace.path().join("link.typ"),
        )
        .unwrap();
        let output = tempfile::tempdir().unwrap();
        let archive = output.path().join("symlink-test.zip");
        let error = export_source_zip(workspace.path(), &archive).unwrap_err();
        assert!(error.contains("Symbolic links"));
    }
}
