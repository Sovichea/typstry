use lopdf::{Document, Object};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

const MAX_FONT_FILE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_TOTAL_FONT_BYTES: u64 = 256 * 1024 * 1024;
const MAX_COLLECTION_FACES: u32 = 64;
const MAX_PACKAGED_FONTS: usize = 128;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackagedFontRecord {
    pub id: String,
    pub family: String,
    pub postscript_name: String,
    pub style: String,
    pub weight: u16,
    pub stretch: u16,
    pub path: String,
    pub sha256: String,
    pub face_index: u32,
    pub format: String,
    pub variable: bool,
    pub source: String,
    pub license: PackagedFontLicense,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackagedFontLicense {
    pub name: String,
    pub redistributable: bool,
    pub modifiable: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FontPackageManifest {
    pub version: u32,
    pub fonts: Vec<PackagedFontRecord>,
}

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn strip_subset_prefix(name: &str) -> &str {
    name.split_once('+')
        .filter(|(prefix, _)| prefix.len() == 6 && prefix.bytes().all(|b| b.is_ascii_uppercase()))
        .map(|(_, name)| name)
        .unwrap_or(name)
}

pub fn pdf_postscript_names(path: &Path) -> Result<BTreeSet<String>, String> {
    let document = Document::load(path)
        .map_err(|error| format!("Failed to audit compiled PDF fonts: {error}"))?;
    let mut names = BTreeSet::new();
    for object in document.objects.values() {
        let Ok(dictionary) = object.as_dict() else {
            continue;
        };
        if let Some(name) = font_name_from_dictionary(dictionary) {
            names.insert(name);
        }
    }
    if names.is_empty() {
        return Err("The validation PDF did not expose any resolvable font identities.".into());
    }
    Ok(names)
}

fn font_name_from_dictionary(dictionary: &lopdf::Dictionary) -> Option<String> {
    let Object::Name(subtype) = dictionary.get(b"Subtype").ok()? else {
        return None;
    };
    if !matches!(
        subtype.as_slice(),
        b"Type0" | b"Type1" | b"TrueType" | b"CIDFontType0" | b"CIDFontType2"
    ) {
        return None;
    }
    let Object::Name(name) = dictionary.get(b"BaseFont").ok()? else {
        return None;
    };
    Some(strip_subset_prefix(&String::from_utf8_lossy(name)).to_string())
}

fn source_bytes(source: &fontdb::Source) -> Result<(Vec<u8>, String), String> {
    match source {
        fontdb::Source::File(path) => fs::read(path)
            .map(|bytes| (bytes, path.to_string_lossy().into_owned()))
            .map_err(|error| format!("Failed to read font '{}': {error}", path.display())),
        fontdb::Source::SharedFile(path, bytes) => Ok((
            bytes.as_ref().as_ref().to_vec(),
            path.to_string_lossy().into_owned(),
        )),
        fontdb::Source::Binary(bytes) => Ok((bytes.as_ref().as_ref().to_vec(), "memory".into())),
    }
}

fn localized_name(face: &ttf_parser::Face<'_>, id: u16) -> Option<String> {
    face.names()
        .into_iter()
        .filter(|name| name.name_id == id)
        .find_map(|name| name.to_string())
}

fn license(face: &ttf_parser::Face<'_>, generated: bool) -> Result<PackagedFontLicense, String> {
    if !face.is_outline_embedding_allowed() {
        return Err("the OpenType embedding flags prohibit outline embedding".into());
    }
    let description = localized_name(face, 13).unwrap_or_default();
    let lower = description.to_lowercase();
    let recognized = lower.contains("open font license")
        || lower.contains("apache license")
        || lower.contains("public domain")
        || lower.contains("ubuntu font licence");
    if !recognized {
        return Err("no recognized redistributable license was found in the font metadata".into());
    }
    let modifiable = lower.contains("open font license")
        || lower.contains("apache license")
        || lower.contains("public domain");
    if generated && !modifiable {
        return Err(
            "the generated font's embedded license does not explicitly permit modification".into(),
        );
    }
    Ok(PackagedFontLicense {
        name: description
            .lines()
            .next()
            .unwrap_or("Redistributable font license")
            .chars()
            .take(160)
            .collect(),
        redistributable: true,
        modifiable,
    })
}

fn extension(bytes: &[u8]) -> Result<&'static str, String> {
    match bytes.get(..4) {
        Some(b"OTTO") => Ok("otf"),
        Some(b"ttcf") => Ok("ttc"),
        Some([0, 1, 0, 0]) | Some(b"true") => Ok("ttf"),
        _ => Err("unsupported font format; only TTF, OTF, and TTC are accepted".into()),
    }
}

fn safe_name(value: &str) -> String {
    let value: String = value
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' {
                c
            } else {
                '-'
            }
        })
        .collect();
    value.trim_matches('-').to_string()
}

pub fn build_package(
    workspace: &Path,
    required: &BTreeSet<String>,
) -> Result<FontPackageManifest, String> {
    if required.len() > MAX_PACKAGED_FONTS {
        return Err(
            "The document uses too many distinct font identities to package safely.".into(),
        );
    }
    let package = workspace.join(".typsastra").join("fonts").join("package");
    let generated = workspace.join(".typsastra").join("fonts").join("generated");
    let mut database = fontdb::Database::new();
    if generated.is_dir() {
        database.load_fonts_dir(&generated);
    }
    database.load_system_fonts();
    let mut by_name = BTreeMap::new();
    for face in database.faces() {
        by_name
            .entry(face.post_script_name.clone())
            .or_insert_with(|| face.clone());
    }
    fs::create_dir_all(package.parent().ok_or("Invalid font package directory.")?)
        .map_err(|error| format!("Failed to create font package directory: {error}"))?;
    let staging = tempfile::tempdir_in(package.parent().ok_or("Invalid font package directory.")?)
        .map_err(|error| format!("Failed to stage font package: {error}"))?;
    let mut records = Vec::new();
    let mut total = 0_u64;
    let mut identities = BTreeSet::new();
    for name in required {
        let face = by_name.get(name).or_else(|| by_name.iter().find(|(candidate, _)| candidate.eq_ignore_ascii_case(name)).map(|(_, face)| face))
            .ok_or_else(|| format!("Font {name:?} was used by the compiler but its exact face file is unavailable. Install a file-backed redistributable version or choose another font."))?;
        let (bytes, source) = source_bytes(&face.source)?;
        if bytes.len() as u64 > MAX_FONT_FILE_BYTES {
            return Err(format!(
                "Font {:?} exceeds the 64 MiB package limit.",
                face.post_script_name
            ));
        }
        total += bytes.len() as u64;
        if total > MAX_TOTAL_FONT_BYTES {
            return Err("The font package exceeds the 256 MiB total limit.".into());
        }
        let count = ttf_parser::fonts_in_collection(&bytes).unwrap_or(1);
        if count > MAX_COLLECTION_FACES {
            return Err(format!(
                "Font collection {:?} contains too many faces.",
                face.post_script_name
            ));
        }
        let parse_started = Instant::now();
        let parsed = ttf_parser::Face::parse(&bytes, face.index).map_err(|_| {
            format!(
                "Font {:?} is corrupt or uses an unsupported face index.",
                face.post_script_name
            )
        })?;
        if parse_started.elapsed() > Duration::from_secs(2) {
            return Err(format!(
                "Font {:?} exceeded the parsing time limit.",
                face.post_script_name
            ));
        }
        let generated_source = source
            .replace('\\', "/")
            .contains("/.typsastra/fonts/generated/");
        let license = license(&parsed, generated_source).map_err(|reason| {
            format!(
                "Font {:?} cannot be packaged: {reason}.",
                face.post_script_name
            )
        })?;
        let ext = extension(&bytes)?;
        let hash = digest(&bytes);
        let file_name = format!(
            "{}-{}.{}",
            safe_name(&face.post_script_name),
            &hash[..16],
            ext
        );
        fs::write(staging.path().join(&file_name), &bytes)
            .map_err(|error| format!("Failed to stage font {file_name}: {error}"))?;
        let identity = format!("{}#{}", face.post_script_name.to_lowercase(), face.index);
        if !identities.insert(identity) {
            return Err(format!(
                "Duplicate packaged font identity {:?}.",
                face.post_script_name
            ));
        }
        records.push(PackagedFontRecord {
            id: format!("{}:{}", face.post_script_name, face.index),
            family: face
                .families
                .first()
                .map(|v| v.0.clone())
                .unwrap_or_else(|| face.post_script_name.clone()),
            postscript_name: face.post_script_name.clone(),
            style: format!("{:?}", face.style).to_lowercase(),
            weight: face.weight.0,
            stretch: face.stretch.to_number(),
            path: format!(".typsastra/fonts/package/{file_name}"),
            sha256: hash,
            face_index: face.index,
            format: ext.into(),
            variable: parsed.is_variable(),
            source: if generated_source {
                "generated".into()
            } else {
                "system".into()
            },
            license,
        });
    }
    records.sort_by(|a, b| {
        a.postscript_name
            .cmp(&b.postscript_name)
            .then(a.face_index.cmp(&b.face_index))
    });
    let manifest = FontPackageManifest {
        version: 1,
        fonts: records,
    };
    fs::write(
        staging.path().join("manifest.json"),
        serde_json::to_vec_pretty(&manifest).map_err(|e| e.to_string())?,
    )
    .map_err(|error| format!("Failed to write font package manifest: {error}"))?;
    if package.exists() {
        fs::remove_dir_all(&package).map_err(|e| format!("Failed to replace font package: {e}"))?;
    }
    fs::create_dir_all(package.parent().unwrap()).map_err(|e| e.to_string())?;
    fs::rename(staging.keep(), &package)
        .map_err(|e| format!("Failed to activate font package: {e}"))?;
    Ok(manifest)
}

pub fn declared_family_faces(
    workspace: &Path,
    families: &[String],
) -> Result<BTreeSet<String>, String> {
    let generated = workspace.join(".typsastra").join("fonts").join("generated");
    let mut database = fontdb::Database::new();
    if generated.is_dir() {
        database.load_fonts_dir(&generated);
    }
    database.load_system_fonts();
    let mut result = BTreeSet::new();
    for family in families
        .iter()
        .map(|family| family.trim())
        .filter(|family| !family.is_empty())
    {
        let names = database
            .faces()
            .filter(|face| {
                face.families
                    .iter()
                    .any(|(name, _)| name.eq_ignore_ascii_case(family))
            })
            .map(|face| face.post_script_name.clone())
            .collect::<Vec<_>>();
        if names.is_empty() {
            return Err(format!(
                "Declared typography font family {family:?} is unavailable."
            ));
        }
        result.extend(names);
    }
    Ok(result)
}

pub fn compile_for_audit(
    tinymist: &Path,
    workspace: &Path,
    main: &Path,
    output: &Path,
    font_dir: Option<&Path>,
    ignore_system: bool,
) -> Result<(), String> {
    let mut command = Command::new(tinymist);
    command
        .current_dir(workspace)
        .arg("compile")
        .arg("--root")
        .arg(workspace);
    if ignore_system {
        command.arg("--ignore-system-fonts");
    }
    if let Some(font_dir) = font_dir {
        command.arg("--font-path").arg(font_dir);
    }
    command.arg(main).arg(output);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let result = command
        .output()
        .map_err(|e| format!("Failed to start font validation compile: {e}"))?;
    if !result.status.success() {
        return Err(format!(
            "Font validation compile failed:\n{}",
            String::from_utf8_lossy(&result.stderr)
        ));
    }
    Ok(())
}

pub fn verify_package_files(
    workspace: &Path,
    manifest: &FontPackageManifest,
) -> Result<PathBuf, String> {
    let directory = workspace.join(".typsastra").join("fonts").join("package");
    let mut total = 0_u64;
    for record in &manifest.fonts {
        let name = Path::new(&record.path)
            .file_name()
            .ok_or("Invalid packaged font path.")?;
        let path = directory.join(name);
        let bytes = fs::read(&path)
            .map_err(|e| format!("Failed to read packaged font '{}': {e}", path.display()))?;
        total += bytes.len() as u64;
        if total > MAX_TOTAL_FONT_BYTES {
            return Err("The packaged fonts exceed the total size limit.".into());
        }
        validate_packaged_font_bytes(
            &bytes,
            record.face_index,
            &record.sha256,
            &record.postscript_name,
        )?;
    }
    Ok(directory)
}

pub fn validate_packaged_font_bytes(
    bytes: &[u8],
    face_index: u32,
    expected_sha256: &str,
    identity: &str,
) -> Result<(), String> {
    if bytes.len() as u64 > MAX_FONT_FILE_BYTES || digest(bytes) != expected_sha256 {
        return Err(format!(
            "Packaged font {identity:?} failed integrity validation."
        ));
    }
    extension(bytes).map_err(|reason| format!("Packaged font {identity:?}: {reason}."))?;
    if ttf_parser::fonts_in_collection(bytes).unwrap_or(1) > MAX_COLLECTION_FACES {
        return Err(format!(
            "Packaged font collection {identity:?} has too many faces."
        ));
    }
    let parse_started = Instant::now();
    ttf_parser::Face::parse(bytes, face_index)
        .map_err(|_| format!("Packaged font {identity:?} is malformed."))?;
    if parse_started.elapsed() > Duration::from_secs(2) {
        return Err(format!(
            "Packaged font {identity:?} exceeded the parsing time limit."
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use lopdf::Dictionary;

    #[test]
    fn compiled_pdf_font_audit_uses_exact_postscript_identity() {
        let mut font = Dictionary::new();
        font.set("Type", Object::Name(b"Font".to_vec()));
        font.set("Subtype", Object::Name(b"Type0".to_vec()));
        font.set(
            "BaseFont",
            Object::Name(b"ABCDEF+MiSansKhmer-Regular".to_vec()),
        );
        assert_eq!(
            font_name_from_dictionary(&font),
            Some("MiSansKhmer-Regular".to_string())
        );
    }

    #[test]
    fn rejects_unknown_and_corrupt_font_formats() {
        assert!(extension(b"wOFFbad").is_err());
        let workspace = tempfile::tempdir().unwrap();
        let package = workspace.path().join(".typsastra/fonts/package");
        fs::create_dir_all(&package).unwrap();
        fs::write(package.join("bad.ttf"), b"not a font").unwrap();
        let manifest = FontPackageManifest {
            version: 1,
            fonts: vec![PackagedFontRecord {
                id: "bad:0".into(),
                family: "Bad".into(),
                postscript_name: "Bad".into(),
                style: "normal".into(),
                weight: 400,
                stretch: 100,
                path: ".typsastra/fonts/package/bad.ttf".into(),
                sha256: digest(b"not a font"),
                face_index: 0,
                format: "ttf".into(),
                variable: false,
                source: "system".into(),
                license: PackagedFontLicense {
                    name: "OFL".into(),
                    redistributable: true,
                    modifiable: true,
                },
            }],
        };
        assert!(verify_package_files(workspace.path(), &manifest).is_err());
    }
}
