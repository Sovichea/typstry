use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

use super::scanner::{scan_typst_content, ScanState};
use super::segment::{prepare_khmer_text_for_rendering, KhmerTextSegmenter};
use super::sourcemap::{MappingKind, SourceMap};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderPrepareWarning {
    pub file_path: PathBuf,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderPrepareOptions {
    pub enable_khmer_zws: bool,
    pub project_root: PathBuf,
    pub entry_file: PathBuf,
    pub cache_root: PathBuf,
    pub generate_source_map: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderPrepareResult {
    pub generated_entry_file: PathBuf,
    pub changed_files: Vec<PathBuf>,
    pub warnings: Vec<RenderPrepareWarning>,
}

pub fn mirror_project(
    options: &RenderPrepareOptions,
    segmenter: &KhmerTextSegmenter,
) -> Result<RenderPrepareResult, String> {
    let project_root = &options.project_root;
    let cache_root = &options.cache_root;

    let render_dir = cache_root.join("render");
    let maps_dir = cache_root.join("maps");

    fs::create_dir_all(&render_dir).map_err(|e| e.to_string())?;
    if options.generate_source_map {
        fs::create_dir_all(&maps_dir).map_err(|e| e.to_string())?;
    }

    let _ = clean_stale_cache_files(&render_dir, &maps_dir, project_root);

    let mut changed_files = Vec::new();
    let mut warnings = Vec::new();

    let mut files_to_process = Vec::new();
    walk_project_dir(
        project_root,
        project_root,
        cache_root,
        &mut files_to_process,
    )
    .map_err(|e| e.to_string())?;

    for (rel_path, is_dir) in files_to_process {
        let src_path = project_root.join(&rel_path);
        let dest_path = render_dir.join(&rel_path);

        if is_dir {
            fs::create_dir_all(&dest_path).map_err(|e| e.to_string())?;
        } else {
            if let Some(parent) = dest_path.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }

            if rel_path.extension().and_then(|s| s.to_str()) == Some("typ") {
                let result = process_typ_file(
                    &src_path, &dest_path, &rel_path, &maps_dir, options, segmenter,
                );
                match result {
                    Ok(changed) => {
                        if changed {
                            changed_files.push(dest_path.clone());
                        }
                    }
                    Err(e) => {
                        warnings.push(RenderPrepareWarning {
                            file_path: src_path.clone(),
                            message: format!("Failed to process Typst file: {}", e),
                        });
                        if let Err(err) = fs::copy(&src_path, &dest_path) {
                            warnings.push(RenderPrepareWarning {
                                file_path: src_path.clone(),
                                message: format!("Fallback copy failed: {}", err),
                            });
                        }
                    }
                }
            } else {
                match link_or_copy_asset(&src_path, &dest_path) {
                    Ok(copied) => {
                        if copied {
                            changed_files.push(dest_path);
                        }
                    }
                    Err(err) => {
                        warnings.push(RenderPrepareWarning {
                            file_path: src_path.clone(),
                            message: format!("Failed to link or copy asset: {}", err),
                        });
                    }
                }
            }
        }
    }

    let generated_entry_file = render_dir.join(
        options
            .entry_file
            .strip_prefix(project_root)
            .unwrap_or(&options.entry_file),
    );

    Ok(RenderPrepareResult {
        generated_entry_file,
        changed_files,
        warnings,
    })
}

fn clean_stale_cache_files(
    render_dir: &Path,
    maps_dir: &Path,
    project_root: &Path,
) -> Result<(), std::io::Error> {
    if !render_dir.exists() {
        return Ok(());
    }
    let mut to_delete = Vec::new();
    walk_for_stale(render_dir, render_dir, project_root, &mut to_delete)?;
    for path in to_delete {
        if path.is_dir() {
            let _ = fs::remove_dir_all(&path);
        } else {
            let _ = fs::remove_file(&path);
            let rel = path.strip_prefix(render_dir).unwrap_or(&path);
            let mut map_rel = rel.to_path_buf();
            let ext = map_rel
                .extension()
                .and_then(|s| s.to_str())
                .unwrap_or("typ");
            map_rel.set_extension(format!("{}.map.json", ext));
            let map_path = maps_dir.join(map_rel);
            if map_path.exists() {
                let _ = fs::remove_file(map_path);
            }
        }
    }
    Ok(())
}

fn walk_for_stale(
    base_render: &Path,
    dir: &Path,
    project_root: &Path,
    out: &mut Vec<PathBuf>,
) -> Result<(), std::io::Error> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        let rel = path.strip_prefix(base_render).unwrap_or(&path);
        let src_path = project_root.join(rel);

        if !src_path.exists() {
            out.push(path);
        } else if path.is_dir() {
            walk_for_stale(base_render, &path, project_root, out)?;
        }
    }
    Ok(())
}

pub fn prepare_single_in_memory_file(
    options: &RenderPrepareOptions,
    segmenter: &KhmerTextSegmenter,
    file_path: &Path,
    source_code: &str,
) -> Result<PathBuf, String> {
    let project_root = &options.project_root;
    let cache_root = &options.cache_root;

    let render_dir = cache_root.join("render");
    let maps_dir = cache_root.join("maps");

    let rel_path = file_path.strip_prefix(project_root).unwrap_or(file_path);
    let dest_path = render_dir.join(rel_path);

    if let Some(parent) = dest_path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let mut sourcemap = SourceMap::new(
        file_path.to_string_lossy().to_string(),
        dest_path.to_string_lossy().to_string(),
    );

    let mut generated_content = String::new();
    let chunks = scan_typst_content(source_code);

    for (state, start, end, scope) in chunks {
        let chunk_text = &source_code[start..end];
        if state == ScanState::MarkupText {
            let prepared = prepare_khmer_text_for_rendering(
                chunk_text,
                &segmenter.segmenter,
                &segmenter.hyphenation,
                start,
                generated_content.len(),
                &mut sourcemap,
                scope,
            );
            generated_content.push_str(&prepared);
        } else {
            let gen_start = generated_content.len();
            generated_content.push_str(chunk_text);
            sourcemap.add_mapping(
                gen_start,
                generated_content.len(),
                start,
                end,
                MappingKind::Original,
            );
        }
    }

    fs::write(&dest_path, &generated_content).map_err(|e| e.to_string())?;

    if options.generate_source_map {
        let mut map_rel = rel_path.to_path_buf();
        let ext = map_rel
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("typ");
        map_rel.set_extension(format!("{}.map.json", ext));
        let map_path = maps_dir.join(map_rel);
        if let Some(parent) = map_path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let map_json = serde_json::to_string_pretty(&sourcemap).map_err(|e| e.to_string())?;
        fs::write(map_path, map_json).map_err(|e| e.to_string())?;
    }

    Ok(dest_path)
}

fn walk_project_dir(
    root: &Path,
    dir: &Path,
    cache_root: &Path,
    out: &mut Vec<(PathBuf, bool)>,
) -> Result<(), std::io::Error> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();

        if path.starts_with(cache_root) || path == cache_root {
            continue;
        }

        let file_name = path.file_name().and_then(|s| s.to_str()).unwrap_or("");
        if file_name.starts_with('.')
            || file_name == "node_modules"
            || file_name == "target"
            || file_name == "dist"
        {
            continue;
        }

        let rel_path = path.strip_prefix(root).unwrap_or(&path).to_path_buf();
        let is_dir = path.is_dir();
        out.push((rel_path.clone(), is_dir));

        if is_dir {
            walk_project_dir(root, &path, cache_root, out)?;
        }
    }
    Ok(())
}

fn link_or_copy_asset(src: &Path, dest: &Path) -> Result<bool, std::io::Error> {
    if dest.exists() {
        if let Ok(meta) = fs::symlink_metadata(dest) {
            if meta.file_type().is_symlink() {
                if let Ok(target) = fs::read_link(dest) {
                    if target == src {
                        return Ok(false);
                    }
                }
                let _ = fs::remove_file(dest);
            } else {
                if let (Ok(src_meta), Ok(dest_meta)) = (fs::metadata(src), fs::metadata(dest)) {
                    if src_meta.len() == dest_meta.len() {
                        if let (Ok(src_modified), Ok(dest_modified)) =
                            (src_meta.modified(), dest_meta.modified())
                        {
                            if src_modified <= dest_modified {
                                return Ok(false);
                            }
                        }
                    }
                }
            }
        }
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::symlink;
        if symlink(src, dest).is_ok() {
            return Ok(true);
        }
    }

    #[cfg(windows)]
    {
        use std::os::windows::fs::symlink_file;
        if symlink_file(src, dest).is_ok() {
            return Ok(true);
        }
    }

    fs::copy(src, dest)?;
    Ok(true)
}

fn process_typ_file(
    src: &Path,
    dest: &Path,
    rel_path: &Path,
    maps_dir: &Path,
    options: &RenderPrepareOptions,
    segmenter: &KhmerTextSegmenter,
) -> Result<bool, String> {
    if dest.exists() {
        if let (Ok(src_meta), Ok(dest_meta)) = (fs::metadata(src), fs::metadata(dest)) {
            if let (Ok(src_mod), Ok(dest_mod)) = (src_meta.modified(), dest_meta.modified()) {
                if src_mod <= dest_mod {
                    let map_exists = if options.generate_source_map {
                        let mut map_rel = rel_path.to_path_buf();
                        let ext = map_rel
                            .extension()
                            .and_then(|s| s.to_str())
                            .unwrap_or("typ");
                        map_rel.set_extension(format!("{}.map.json", ext));
                        maps_dir.join(map_rel).exists()
                    } else {
                        true
                    };
                    if map_exists {
                        return Ok(false);
                    }
                }
            }
        }
    }

    let source_content = fs::read_to_string(src).map_err(|e| e.to_string())?;

    let mut sourcemap = SourceMap::new(
        src.to_string_lossy().to_string(),
        dest.to_string_lossy().to_string(),
    );

    let mut generated_content = String::new();
    let chunks = scan_typst_content(&source_content);

    for (state, start, end, scope) in chunks {
        let chunk_text = &source_content[start..end];
        if state == ScanState::MarkupText {
            let prepared = prepare_khmer_text_for_rendering(
                chunk_text,
                &segmenter.segmenter,
                &segmenter.hyphenation,
                start,
                generated_content.len(),
                &mut sourcemap,
                scope,
            );
            generated_content.push_str(&prepared);
        } else {
            let gen_start = generated_content.len();
            generated_content.push_str(chunk_text);
            sourcemap.add_mapping(
                gen_start,
                generated_content.len(),
                start,
                end,
                MappingKind::Original,
            );
        }
    }

    fs::write(dest, &generated_content).map_err(|e| e.to_string())?;

    if options.generate_source_map {
        let mut map_rel = rel_path.to_path_buf();
        let ext = map_rel
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("typ");
        map_rel.set_extension(format!("{}.map.json", ext));
        let map_path = maps_dir.join(map_rel);
        if let Some(parent) = map_path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let map_json = serde_json::to_string_pretty(&sourcemap).map_err(|e| e.to_string())?;
        fs::write(map_path, map_json).map_err(|e| e.to_string())?;
    }

    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prepares_khmer_hyphenation_boundaries_as_zws_only() {
        let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let project_root = manifest_dir
            .join("resources")
            .join("examples")
            .join("10-khmer-segmentation-comparison");
        let source_path = project_root.join("main.typ");
        let source = fs::read_to_string(&source_path).unwrap();
        let segmenter = KhmerTextSegmenter::new().unwrap();
        let cache_root = std::env::temp_dir().join("typstry-khmer-prepare-scope-test");
        let _ = fs::remove_dir_all(&cache_root);
        let options = RenderPrepareOptions {
            enable_khmer_zws: true,
            project_root: project_root.clone(),
            entry_file: source_path.clone(),
            cache_root: cache_root.clone(),
            generate_source_map: true,
        };

        let prepared_path =
            prepare_single_in_memory_file(&options, &segmenter, &source_path, &source).unwrap();
        let prepared = fs::read_to_string(prepared_path).unwrap();
        let _ = fs::remove_dir_all(&cache_root);

        assert!(
            prepared.contains('\u{200b}'),
            "prepared example should contain ZWSP layout breaks"
        );
        assert!(
            !prepared.contains('\u{00ad}'),
            "Khmer render preparation should not insert SHY"
        );
        assert!(
            !prepared.contains("\u{1780}\u{17d2}\u{1793}\u{17bb}\u{200b}\u{1784}"),
            "prepared example must not split ក្នុង with ZWSP"
        );
    }
}
