use super::provider::{LanguageSegmenter, RenderReplacement, SegmentToken, TextAnalysis};
use khmer_segmenter::kdict::KHypDict;
use khmer_segmenter::{KhmerSegmenter, SegmenterConfig};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;

const KHMER_DICTIONARY: &[u8] =
    include_bytes!("../../../third_party/khmer_segmenter/port/common/khmer_dictionary.kdict");
const KHMER_WORDS: &str = include_str!(
    "../../../third_party/khmer_segmenter/khmer_segmenter/dictionary_data/khmer_dictionary_words.txt"
);
const KHMER_HYPHENATION: &[u8] =
    include_bytes!("../../../third_party/khmer_segmenter/port/common/khmer_hyphenation.kdict");

struct KhmerProvider {
    segmenter: KhmerSegmenter,
    words: Vec<String>,
    known: HashSet<String>,
    hyphenation: KHypDict,
}

impl KhmerProvider {
    fn new() -> Result<Self, String> {
        let segmenter =
            KhmerSegmenter::from_bytes(KHMER_DICTIONARY.to_vec(), SegmenterConfig::default())
                .map_err(|error| format!("Failed to load Khmer dictionary: {error}"))?;
        let mut words: Vec<String> = KHMER_WORDS
            .lines()
            .map(str::trim)
            .filter(|word| !word.is_empty())
            .map(str::to_owned)
            .collect();
        words.sort();
        words.dedup();
        let known = words.iter().cloned().collect();
        let hyphenation = KHypDict::from_bytes(KHMER_HYPHENATION.to_vec())
            .map_err(|error| format!("Failed to load Khmer hyphenation dictionary: {error}"))?;
        Ok(Self {
            segmenter,
            words,
            known,
            hyphenation,
        })
    }

    fn has_prefix(&self, prefix: &str) -> bool {
        let index = self
            .words
            .partition_point(|candidate| candidate.as_str() < prefix);
        self.words
            .get(index)
            .is_some_and(|candidate| candidate.starts_with(prefix))
    }
}

fn utf16_offset(text: &str, byte_offset: usize) -> usize {
    text[..byte_offset].encode_utf16().count()
}

fn edit_distance(left: &str, right: &str) -> usize {
    let right_chars: Vec<char> = right.chars().collect();
    let mut previous: Vec<usize> = (0..=right_chars.len()).collect();
    for (left_index, left_char) in left.chars().enumerate() {
        let mut current = vec![left_index + 1];
        for (right_index, right_char) in right_chars.iter().enumerate() {
            current.push(
                (previous[right_index + 1] + 1)
                    .min(current[right_index] + 1)
                    .min(previous[right_index] + usize::from(left_char != *right_char)),
            );
        }
        previous = current;
    }
    previous[right_chars.len()]
}

impl LanguageSegmenter for KhmerProvider {
    fn id(&self) -> &'static str {
        "khmer-segmenter"
    }

    fn supports(&self, text: &str) -> bool {
        text.chars()
            .any(|character| ('\u{1780}'..='\u{17ff}').contains(&character))
    }

    fn analyze(&self, text: &str) -> Result<TextAnalysis, String> {
        let result = self
            .segmenter
            .segment_detailed(text)
            .map_err(|error| error.to_string())?;
        let normalized_changed = result.normalized() != text;
        let tokens = if normalized_changed {
            Vec::new()
        } else {
            result
                .ranges()
                .iter()
                .map(|range| {
                    let token = &text[range.clone()];
                    let known = self.known.contains(token)
                        || token
                            .chars()
                            .all(|character| !('\u{1780}'..='\u{17ff}').contains(&character));
                    SegmentToken {
                        text: token.to_owned(),
                        from: utf16_offset(text, range.start),
                        to: utf16_offset(text, range.end),
                        known,
                        known_prefix: known || self.has_prefix(token),
                    }
                })
                .collect()
        };
        Ok(TextAnalysis {
            provider: self.id(),
            normalized_changed,
            tokens,
        })
    }

    fn suggestions(&self, word: &str, limit: usize) -> Vec<String> {
        let first = word.chars().next();
        let length = word.chars().count();
        let mut candidates: Vec<(usize, &str)> = self
            .words
            .iter()
            .map(String::as_str)
            .filter(|candidate| candidate.chars().next() == first)
            .filter(|candidate| candidate.chars().count().abs_diff(length) <= 2)
            .map(|candidate| (edit_distance(word, candidate), candidate))
            .filter(|(distance, _)| *distance <= 3)
            .collect();
        candidates.sort_by(|left, right| {
            left.0
                .cmp(&right.0)
                .then_with(|| left.1.len().cmp(&right.1.len()))
        });
        candidates.dedup_by(|left, right| left.1 == right.1);
        candidates
            .into_iter()
            .take(limit)
            .map(|(_, candidate)| candidate.to_owned())
            .collect()
    }

    fn render_replacements(&self, text: &str) -> Vec<RenderReplacement> {
        let mut runs = Vec::new();
        let mut start = None;
        for (index, character) in text.char_indices() {
            let is_khmer = ('\u{1780}'..='\u{17ff}').contains(&character);
            match (start, is_khmer) {
                (None, true) => start = Some(index),
                (Some(from), false) => {
                    runs.push(&text[from..index]);
                    start = None;
                }
                _ => {}
            }
        }
        if let Some(from) = start {
            runs.push(&text[from..]);
        }

        runs.into_iter()
            .filter_map(|source| {
                let segmentation = self.segmenter.segment_detailed(source).ok()?;
                if segmentation.normalized() != source {
                    return None;
                }
                let segmented = segmentation.join("\u{200b}");
                let hyphenated = segmentation
                    .tokens()
                    .map(|token| {
                        self.hyphenation
                            .lookup(token)
                            .map(|value| value.replace('\u{200b}', "\u{00ad}"))
                            .unwrap_or_else(|| token.to_owned())
                    })
                    .collect::<Vec<_>>()
                    .join("\u{200b}");
                (segmented != source || hyphenated != source).then(|| RenderReplacement {
                    source: source.to_owned(),
                    segmented,
                    hyphenated,
                })
            })
            .collect()
    }
}

pub struct SegmentationRegistry {
    providers: Vec<Arc<dyn LanguageSegmenter>>,
}

fn collect_sources(
    root: &Path,
    active_path: &Path,
    active_contents: &str,
    sources: &mut Vec<String>,
) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            let name = entry.file_name();
            if name != ".git" && name != "target" && name != "node_modules" {
                collect_sources(&path, active_path, active_contents, sources);
            }
        } else if path.extension().and_then(|extension| extension.to_str()) == Some("typ")
            && !path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or_default()
                .contains("typstry-preview")
        {
            if path == active_path {
                sources.push(active_contents.to_owned());
            } else if let Ok(source) = std::fs::read_to_string(path) {
                sources.push(source);
            }
        }
    }
}

fn typst_string(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_owned())
}

impl SegmentationRegistry {
    pub fn new() -> Result<Self, String> {
        Ok(Self {
            providers: vec![Arc::new(KhmerProvider::new()?)],
        })
    }

    fn provider_for(&self, text: &str) -> Option<&dyn LanguageSegmenter> {
        self.providers
            .iter()
            .find(|provider| provider.supports(text))
            .map(AsRef::as_ref)
    }
}

#[tauri::command]
pub fn analyze_text(
    registry: tauri::State<'_, SegmentationRegistry>,
    text: String,
) -> Result<Option<TextAnalysis>, String> {
    registry
        .provider_for(&text)
        .map(|provider| provider.analyze(&text))
        .transpose()
}

#[tauri::command]
pub fn spelling_suggestions(
    registry: tauri::State<'_, SegmentationRegistry>,
    word: String,
    limit: Option<usize>,
) -> Vec<String> {
    registry
        .provider_for(&word)
        .map(|provider| provider.suggestions(&word, limit.unwrap_or(5).min(10)))
        .unwrap_or_default()
}

#[tauri::command]
pub fn segmentation_prelude(
    registry: tauri::State<'_, SegmentationRegistry>,
    workspace_root_path: String,
    active_file_path: String,
    active_contents: String,
) -> String {
    let mut sources = Vec::new();
    collect_sources(
        &PathBuf::from(workspace_root_path),
        &PathBuf::from(active_file_path),
        &active_contents,
        &mut sources,
    );
    let mut replacements = registry
        .providers
        .iter()
        .flat_map(|provider| {
            sources
                .iter()
                .flat_map(|source| provider.render_replacements(source))
        })
        .collect::<Vec<_>>();
    replacements.sort_by(|left, right| left.source.cmp(&right.source));
    replacements.dedup_by(|left, right| left.source == right.source);
    replacements
        .into_iter()
        .map(|replacement| {
            format!(
                "#show {}: context {{\n  if par.justify {{ text({}) }} else {{ text({}) }}\n}}",
                typst_string(&replacement.source),
                typst_string(&replacement.hyphenated),
                typst_string(&replacement.segmented),
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn analyzes_khmer_with_editor_safe_ranges() {
        let provider = KhmerProvider::new().expect("Khmer provider");
        let analysis = provider.analyze("ក្រុមហ៊ុនទទួលបានប្រាក់ចំណូល").expect("analysis");
        assert!(!analysis.normalized_changed);
        assert!(!analysis.tokens.is_empty());
        assert!(analysis.tokens.iter().all(|token| token.from <= token.to));
    }

    #[test]
    fn emits_discretionary_hyphenation_for_typst() {
        let provider = KhmerProvider::new().expect("Khmer provider");
        let replacements = provider.render_replacements("កក្រើករំជួល");
        assert!(replacements
            .iter()
            .any(|replacement| replacement.hyphenated.contains('\u{00ad}')));
    }
}
