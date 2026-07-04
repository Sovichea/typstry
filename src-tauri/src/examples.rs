use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;
use tauri::Manager;

const EXAMPLES_DIRECTORY_NAME: &str = "Typstry Examples";
const START_FILE_NAME: &str = "START-HERE.typ";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExamplesWorkspace {
    workspace_path: String,
    entry_path: String,
}

#[derive(Default, Deserialize, Serialize)]
struct ExamplesState {
    files: BTreeMap<String, String>,
}

fn fingerprint(contents: &[u8]) -> String {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in contents {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

fn migrate_legacy_contents(relative_path: &str, contents: Vec<u8>) -> Vec<u8> {
    let Ok(text) = String::from_utf8(contents.clone()) else {
        return contents;
    };
    let migrated = match relative_path {
        "01-writing-basics/main.typ" => text.replace(
            "..measurements.map(row => (row.at(0), str(row.at(1)))),",
            "..measurements.map(row => (row.at(0), str(row.at(1)))).flatten(),",
        ),
        "templates/multilingual-article/template.typ" => text
            .replace(
                "  title:,\n  author:,",
                "  title: \"Untitled Article\",\n  author: \"Anonymous\",",
            )
            .replace(
                "  title:,\r\n  author:,",
                "  title: \"Untitled Article\",\r\n  author: \"Anonymous\",",
            ),
        _ => text,
    };
    migrated.into_bytes()
}

fn sync_tree(
    source: &Path,
    destination: &Path,
    relative_directory: &Path,
    previous: &ExamplesState,
    next: &mut ExamplesState,
) -> Result<(), String> {
    std::fs::create_dir_all(destination).map_err(|error| {
        format!(
            "Failed to create examples directory {}: {error}",
            destination.display()
        )
    })?;

    for entry in std::fs::read_dir(source)
        .map_err(|error| format!("Failed to read bundled examples: {error}"))?
    {
        let entry = entry.map_err(|error| format!("Failed to read bundled example: {error}"))?;
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());
        let relative_path = relative_directory.join(entry.file_name());
        let file_type = entry
            .file_type()
            .map_err(|error| format!("Failed to inspect bundled example: {error}"))?;

        if file_type.is_dir() {
            sync_tree(
                &source_path,
                &destination_path,
                &relative_path,
                previous,
                next,
            )?;
        } else if file_type.is_file() {
            let relative_key = relative_path.to_string_lossy().replace('\\', "/");
            let bundled = std::fs::read(&source_path)
                .map_err(|error| format!("Failed to read bundled example: {error}"))?;
            let bundled_fingerprint = fingerprint(&bundled);
            let installed = if destination_path.exists() {
                let current = std::fs::read(&destination_path).map_err(|error| {
                    format!(
                        "Failed to read installed example {}: {error}",
                        destination_path.display()
                    )
                })?;
                let current_fingerprint = fingerprint(&current);
                let migrated = migrate_legacy_contents(&relative_key, current);
                if fingerprint(&migrated) != current_fingerprint {
                    std::fs::write(&destination_path, &migrated).map_err(|error| {
                        format!(
                            "Failed to migrate example {}: {error}",
                            destination_path.display()
                        )
                    })?;
                }
                migrated
            } else {
                std::fs::write(&destination_path, &bundled).map_err(|error| {
                    format!(
                        "Failed to install example {}: {error}",
                        destination_path.display()
                    )
                })?;
                bundled.clone()
            };

            let installed_fingerprint = fingerprint(&installed);
            let was_untouched = previous.files.get(&relative_key) == Some(&installed_fingerprint);
            if was_untouched && installed_fingerprint != bundled_fingerprint {
                std::fs::write(&destination_path, &bundled).map_err(|error| {
                    format!(
                        "Failed to update example {}: {error}",
                        destination_path.display()
                    )
                })?;
                next.files.insert(relative_key, bundled_fingerprint);
            } else if installed_fingerprint == bundled_fingerprint {
                next.files.insert(relative_key, bundled_fingerprint);
            } else if let Some(previous_fingerprint) = previous.files.get(&relative_key) {
                next.files
                    .insert(relative_key, previous_fingerprint.clone());
            }
        }
    }

    Ok(())
}

fn sync_examples(source: &Path, destination: &Path, state_path: &Path) -> Result<(), String> {
    let previous = std::fs::read_to_string(state_path)
        .ok()
        .and_then(|contents| serde_json::from_str(&contents).ok())
        .unwrap_or_default();
    let mut next = ExamplesState::default();
    sync_tree(source, destination, Path::new(""), &previous, &mut next)?;
    prune_removed_managed_examples(destination, &previous, &next)?;
    if let Some(parent) = state_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create examples state directory: {error}"))?;
    }
    let serialized = serde_json::to_string_pretty(&next)
        .map_err(|error| format!("Failed to serialize examples state: {error}"))?;
    std::fs::write(state_path, format!("{serialized}\n"))
        .map_err(|error| format!("Failed to save examples state: {error}"))
}

fn prune_removed_managed_examples(
    destination: &Path,
    previous: &ExamplesState,
    next: &ExamplesState,
) -> Result<(), String> {
    for (relative_key, previous_fingerprint) in &previous.files {
        if next.files.contains_key(relative_key) {
            continue;
        }
        let relative_path = Path::new(relative_key);
        if relative_path.is_absolute()
            || relative_path
                .components()
                .any(|component| matches!(component, std::path::Component::ParentDir))
        {
            continue;
        }
        let installed_path = destination.join(relative_path);
        if !installed_path.is_file() {
            continue;
        }
        let installed = std::fs::read(&installed_path).map_err(|error| {
            format!(
                "Failed to read installed example {}: {error}",
                installed_path.display()
            )
        })?;
        if fingerprint(&installed) != *previous_fingerprint {
            continue;
        }
        std::fs::remove_file(&installed_path).map_err(|error| {
            format!(
                "Failed to remove retired example {}: {error}",
                installed_path.display()
            )
        })?;

        let mut parent = installed_path.parent();
        while let Some(directory) = parent {
            if directory == destination {
                break;
            }
            match std::fs::remove_dir(directory) {
                Ok(()) => parent = directory.parent(),
                Err(_) => break,
            }
        }
    }
    Ok(())
}

pub fn install_examples_workspace(
    app_handle: &tauri::AppHandle,
) -> Result<ExamplesWorkspace, String> {
    let source = app_handle
        .path()
        .resource_dir()
        .map_err(|error| format!("Failed to resolve application resources: {error}"))?
        .join("examples");
    if !source.is_dir() {
        return Err(format!(
            "Bundled examples directory was not found at {}",
            source.display()
        ));
    }

    let destination = app_handle
        .path()
        .document_dir()
        .map_err(|error| format!("Failed to resolve the operating system Documents path: {error}"))?
        .join(EXAMPLES_DIRECTORY_NAME);
    let state_path = app_handle
        .path()
        .app_config_dir()
        .map_err(|error| format!("Failed to resolve application configuration: {error}"))?
        .join("examples-state.json");
    sync_examples(&source, &destination, &state_path)?;

    let entry_path = destination.join(START_FILE_NAME);
    if !entry_path.is_file() {
        return Err(format!(
            "The example start document was not installed at {}",
            entry_path.display()
        ));
    }

    Ok(ExamplesWorkspace {
        workspace_path: destination.to_string_lossy().into_owned(),
        entry_path: entry_path.to_string_lossy().into_owned(),
    })
}

#[tauri::command]
pub fn prepare_examples_workspace(
    app_handle: tauri::AppHandle,
) -> Result<ExamplesWorkspace, String> {
    install_examples_workspace(&app_handle)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn installs_missing_examples_without_overwriting_user_changes() {
        let source_parent = tempfile::tempdir().expect("source tempdir");
        let destination_parent = tempfile::tempdir().expect("destination tempdir");
        let source = source_parent.path().join("examples");
        let destination = destination_parent.path().join("Typstry Examples");
        let state = destination_parent.path().join("examples-state.json");
        std::fs::create_dir_all(source.join("nested")).expect("source directories");
        std::fs::create_dir_all(destination.join("nested")).expect("destination directories");
        std::fs::write(source.join(START_FILE_NAME), "bundled start").expect("source start");
        std::fs::write(source.join("nested/main.typ"), "bundled example").expect("source example");
        std::fs::write(destination.join(START_FILE_NAME), "user-edited start").expect("user start");

        sync_examples(&source, &destination, &state).expect("copy examples");

        assert_eq!(
            std::fs::read_to_string(destination.join(START_FILE_NAME)).expect("installed start"),
            "user-edited start"
        );
        assert_eq!(
            std::fs::read_to_string(destination.join("nested/main.typ"))
                .expect("installed example"),
            "bundled example"
        );
    }

    #[test]
    fn updates_untouched_examples_and_preserves_later_user_edits() {
        let source_parent = tempfile::tempdir().expect("source tempdir");
        let destination_parent = tempfile::tempdir().expect("destination tempdir");
        let source = source_parent.path().join("examples");
        let destination = destination_parent.path().join("Typstry Examples");
        let state = destination_parent.path().join("examples-state.json");
        std::fs::create_dir_all(&source).expect("source directory");
        std::fs::write(source.join(START_FILE_NAME), "bundled v1").expect("source v1");
        sync_examples(&source, &destination, &state).expect("initial sync");

        std::fs::write(source.join(START_FILE_NAME), "bundled v2").expect("source v2");
        sync_examples(&source, &destination, &state).expect("managed update");
        assert_eq!(
            std::fs::read_to_string(destination.join(START_FILE_NAME)).expect("updated example"),
            "bundled v2"
        );

        std::fs::write(destination.join(START_FILE_NAME), "user edit").expect("user edit");
        std::fs::write(source.join(START_FILE_NAME), "bundled v3").expect("source v3");
        sync_examples(&source, &destination, &state).expect("preserving update");
        assert_eq!(
            std::fs::read_to_string(destination.join(START_FILE_NAME)).expect("preserved example"),
            "user edit"
        );
    }

    #[test]
    fn removes_retired_examples_only_when_untouched() {
        let source_parent = tempfile::tempdir().expect("source tempdir");
        let destination_parent = tempfile::tempdir().expect("destination tempdir");
        let source = source_parent.path().join("examples");
        let destination = destination_parent.path().join("Typstry Examples");
        let state = destination_parent.path().join("examples-state.json");
        std::fs::create_dir_all(source.join("retired")).expect("source directory");
        std::fs::write(source.join(START_FILE_NAME), "start").expect("source start");
        std::fs::write(source.join("retired/main.typ"), "retired v1").expect("retired source");
        sync_examples(&source, &destination, &state).expect("initial sync");

        std::fs::remove_dir_all(source.join("retired")).expect("remove retired source");
        sync_examples(&source, &destination, &state).expect("remove untouched retired example");
        assert!(!destination.join("retired/main.typ").exists());

        std::fs::create_dir_all(source.join("edited")).expect("edited source directory");
        std::fs::write(source.join("edited/main.typ"), "edited v1").expect("edited source");
        sync_examples(&source, &destination, &state).expect("sync editable example");
        std::fs::write(destination.join("edited/main.typ"), "user edit").expect("user edit");
        std::fs::remove_dir_all(source.join("edited")).expect("remove edited source");
        sync_examples(&source, &destination, &state).expect("preserve edited retired example");
        assert_eq!(
            std::fs::read_to_string(destination.join("edited/main.typ"))
                .expect("preserved retired user edit"),
            "user edit"
        );
    }

    #[test]
    fn migrates_the_original_example_syntax_errors() {
        let writing = migrate_legacy_contents(
            "01-writing-basics/main.typ",
            b"..measurements.map(row => (row.at(0), str(row.at(1)))),".to_vec(),
        );
        assert!(String::from_utf8(writing)
            .expect("writing example")
            .contains(".flatten(),"));

        let template = migrate_legacy_contents(
            "templates/multilingual-article/template.typ",
            b"  title:,\n  author:,".to_vec(),
        );
        let template = String::from_utf8(template).expect("template example");
        assert!(template.contains("title: \"Untitled Article\""));
        assert!(template.contains("author: \"Anonymous\""));
    }

    #[test]
    fn test_khmer_example_exists_in_resources() {
        let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
        let khmer_path = manifest_dir.join("resources/examples/07-khmer-example/main.typ");
        assert!(
            khmer_path.is_file(),
            "07-khmer-example/main.typ must exist in the resources directory"
        );
    }

    #[test]
    fn khmer_folklore_example_is_multifile() {
        let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
        let example_dir = manifest_dir.join("resources/examples/09-khmer-folklore-book");
        assert!(example_dir.join("main.typ").is_file());
        assert!(example_dir
            .join("stories/01-rabbit-and-snail.typ")
            .is_file());
        assert!(example_dir.join("stories/02-crab-and-heron.typ").is_file());
        assert!(example_dir.join("stories/03-three-sons.typ").is_file());
    }

    #[test]
    fn khmer_segmentation_comparison_example_exists() {
        let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
        let example_path =
            manifest_dir.join("resources/examples/10-khmer-segmentation-comparison/main.typ");
        assert!(
            example_path.is_file(),
            "10-khmer-segmentation-comparison/main.typ must exist in the resources directory"
        );
    }
}
