use super::provider::{
    AnalyzeRequest, AnalyzeResponse, CompletionRequest, CompletionResponse, EditorToken,
    LanguageSegmenter, ProviderCapabilities, SegmentToken, SuggestionRequest,
    SuggestionResponse, TextAnalysis,
};
use khmer_segmenter::kdict::{KDict, KHypDict};
use khmer_segmenter::{KhmerSegmenter, SegmenterConfig};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

const KHMER_DICTIONARY: &[u8] =
    include_bytes!("../../../third_party/khmer_segmenter/port/common/khmer_dictionary.kdict");
const KHMER_WORDS: &str = include_str!(
    "../../../third_party/khmer_segmenter/khmer_segmenter/dictionary_data/khmer_dictionary_words.txt"
);
const KHMER_HYPHENATION: &[u8] =
    include_bytes!("../../../third_party/khmer_segmenter/port/common/khmer_hyphenation.kdict");

fn khmer_clusters(text: &str) -> Vec<String> {
    let mut clusters = Vec::new();
    let mut current = String::new();
    let mut prev_is_coeng = false;
    for c in text.chars() {
        let is_base = ('\u{1780}'..='\u{17b3}').contains(&c);
        if is_base && !current.is_empty() && !prev_is_coeng {
            clusters.push(current);
            current = String::new();
        }
        current.push(c);
        prev_is_coeng = c == '\u{17d2}';
    }
    if !current.is_empty() {
        clusters.push(current);
    }
    clusters
}

fn cluster_edit_distance(left: &[String], right: &[String]) -> usize {
    let mut previous: Vec<usize> = (0..=right.len()).collect();
    for (left_index, left_cluster) in left.iter().enumerate() {
        let mut current = vec![left_index + 1];
        for (right_index, right_cluster) in right.iter().enumerate() {
            current.push(
                (previous[right_index + 1] + 1)
                    .min(current[right_index] + 1)
                    .min(previous[right_index] + usize::from(left_cluster != right_cluster)),
            );
        }
        previous = current;
    }
    previous[right.len()]
}

#[derive(Clone, Debug)]
pub struct IndexedWord {
    pub word: String,
    pub clusters: Vec<String>,
    pub cost: f32,
}

struct KhmerProvider {
    segmenter: KhmerSegmenter,
    lookup_words: Vec<String>,
    known: HashSet<String>,
    completion_costs: HashMap<String, f32>,
    hyphenation: KHypDict,
    suggestion_index: HashMap<char, Vec<IndexedWord>>,
    top_frequent_words: Vec<IndexedWord>,
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
            .filter(|word| {
                !word.chars().any(|c| {
                    c.is_ascii_punctuation()
                        || c.is_whitespace()
                        || c.is_ascii_digit()
                        || c == '\u{17d4}' // ។
                        || c == '\u{17d5}' // ៕
                        || ('\u{17e0}'..='\u{17e9}').contains(&c) // Khmer digits
                })
            })
            .map(str::to_owned)
            .collect();
        words.sort();
        words.dedup();
        let hyphenation = KHypDict::from_bytes(KHMER_HYPHENATION.to_vec())
            .map_err(|error| format!("Failed to load Khmer hyphenation dictionary: {error}"))?;
        let completion_dictionary = KDict::from_bytes(KHMER_DICTIONARY.to_vec())
            .map_err(|error| format!("Failed to load Khmer completion dictionary: {error}"))?;
        let mut completion_costs = HashMap::<String, f32>::new();
        for word in &words {
            let key = modern_khmer_key(word);
            let cost = completion_dictionary.cost(word).unwrap_or(f32::MAX);
            completion_costs
                .entry(key)
                .and_modify(|current| *current = current.min(cost))
                .or_insert(cost);
        }
        let mut lookup_words: Vec<String> = completion_costs.keys().cloned().collect();
        lookup_words.sort();
        let known = lookup_words.iter().cloned().collect();

        // Build Suggestion Index
        let mut suggestion_index = HashMap::<char, Vec<IndexedWord>>::new();
        let mut all_indexed_words = Vec::<IndexedWord>::new();
        for word in &lookup_words {
            let key = modern_khmer_key(word);
            let cost = completion_costs.get(&key).copied().unwrap_or(f32::MAX);
            let clusters = khmer_clusters(&key);
            if let Some(first_char) = key.chars().next() {
                let indexed = IndexedWord {
                    word: key.clone(),
                    clusters,
                    cost,
                };
                suggestion_index
                    .entry(first_char)
                    .or_default()
                    .push(indexed.clone());
                all_indexed_words.push(indexed);
            }
        }

        // Sort all indexed words by cost to get the top frequent words for fallback
        all_indexed_words.sort_by(|a, b| {
            a.cost
                .partial_cmp(&b.cost)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        let top_frequent_words = all_indexed_words.iter().take(1000).cloned().collect();

        Ok(Self {
            segmenter,
            lookup_words,
            known,
            completion_costs,
            hyphenation,
            suggestion_index,
            top_frequent_words,
        })
    }

    fn has_prefix(&self, prefix: &str) -> bool {
        let prefix = modern_khmer_key(prefix);
        let index = self
            .lookup_words
            .partition_point(|candidate| candidate.as_str() < prefix.as_str());
        self.lookup_words
            .get(index)
            .is_some_and(|candidate| candidate.starts_with(&prefix))
    }
}

/// Modern Khmer renders COENG+DA and COENG+TA identically. Use COENG+TA as
/// the provider's comparison key while retaining the original source text.
fn modern_khmer_key(text: &str) -> String {
    let mut output = String::with_capacity(text.len());
    let mut characters = text.chars().peekable();
    while let Some(character) = characters.next() {
        output.push(character);
        if character == '\u{17d2}' && characters.peek() == Some(&'\u{178a}') {
            characters.next();
            output.push('\u{178f}');
        }
    }
    output
}

impl LanguageSegmenter for KhmerProvider {
    fn id(&self) -> &'static str {
        "khmer-segmenter"
    }

    fn pattern(&self) -> &'static str {
        "[\u{1780}-\u{17ff}]+"
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
        let normalized = result.normalized();
        let clean_text: String = text
            .chars()
            .filter(|&c| c != '\u{200b}' && c != '\u{200c}' && c != '\u{200d}')
            .collect();
        let normalized_changed = normalized != clean_text;
        let mut byte_to_utf16 = vec![0; text.len() + 1];
        let mut utf16_offset = 0;
        for (byte_offset, character) in text.char_indices() {
            byte_to_utf16[byte_offset] = utf16_offset;
            utf16_offset += character.len_utf16();
        }
        byte_to_utf16[text.len()] = utf16_offset;
        let is_spelling_char = |character: char| ('\u{1780}'..='\u{17d3}').contains(&character);
        let tokens = result
            .mapped_segments()
            .iter()
            .map(|segment| {
                let token = &normalized[segment.normalized_range.clone()];
                let lookup_key = modern_khmer_key(token);
                let known =
                    !token.chars().any(is_spelling_char) || self.known.contains(&lookup_key);
                let hyphenated = self.hyphenation
                    .lookup(token)
                    .map(|value| value.replace('\u{200b}', "\u{00ad}"));
                SegmentToken {
                    text: token.to_owned(),
                    from: byte_to_utf16[segment.source_range.start],
                    to: byte_to_utf16[segment.source_range.end],
                    known,
                    known_prefix: known || self.has_prefix(token),
                    hyphenated,
                }
            })
            .collect();
        Ok(TextAnalysis {
            provider: self.id(),
            normalized_changed,
            tokens,
        })
    }

    fn suggestions(&self, word: &str, limit: usize) -> Vec<String> {
        if word.is_empty() || limit == 0 {
            return Vec::new();
        }
        let word = modern_khmer_key(word);
        let word_clusters = khmer_clusters(&word);
        if word_clusters.is_empty() {
            return Vec::new();
        }

        // 1. Prefix matches first (same as original code, but fast)
        let prefix_index = self
            .lookup_words
            .partition_point(|candidate| candidate.as_str() < word.as_str());
        let mut suggestions: Vec<String> = self
            .lookup_words
            .iter()
            .skip(prefix_index)
            .take_while(|candidate| candidate.starts_with(&word))
            .filter(|candidate| candidate.as_str() != word.as_str())
            .take(limit)
            .cloned()
            .collect();

        if suggestions.len() == limit {
            return suggestions;
        }

        // 2. Fetch candidates from the first char bucket
        let mut candidates = Vec::new();
        if let Some(first_char) = word.chars().next() {
            if let Some(bucket) = self.suggestion_index.get(&first_char) {
                let length = word_clusters.len();
                candidates = bucket
                    .iter()
                    .filter(|candidate| candidate.clusters.len().abs_diff(length) <= 2)
                    .cloned()
                    .collect();
            }
        }

        // If candidates are empty, try fallback to top frequent words
        if candidates.is_empty() {
            let length = word_clusters.len();
            candidates = self
                .top_frequent_words
                .iter()
                .filter(|candidate| candidate.clusters.len().abs_diff(length) <= 2)
                .cloned()
                .collect();
        }

        // Bound candidate count before edit distance calculation
        if candidates.len() > 1000 {
            let length = word_clusters.len();
            candidates.sort_by(|a, b| {
                let a_diff = a.clusters.len().abs_diff(length);
                let b_diff = b.clusters.len().abs_diff(length);
                a_diff.cmp(&b_diff).then_with(|| {
                    a.cost
                        .partial_cmp(&b.cost)
                        .unwrap_or(std::cmp::Ordering::Equal)
                })
            });
            candidates.truncate(1000);
        }

        // Compute edit distance and rank
        let mut ranked: Vec<(usize, f32, &IndexedWord)> = candidates
            .iter()
            .map(|candidate| {
                let distance = cluster_edit_distance(&word_clusters, &candidate.clusters);
                (distance, candidate.cost, candidate)
            })
            .filter(|(distance, _, _)| *distance <= 3)
            .collect();

        // Sort by distance, then cost, then length difference, then lexical
        ranked.sort_by(|a, b| {
            a.0.cmp(&b.0)
                .then_with(|| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal))
                .then_with(|| {
                    let a_len_diff = a.2.clusters.len().abs_diff(word_clusters.len());
                    let b_len_diff = b.2.clusters.len().abs_diff(word_clusters.len());
                    a_len_diff.cmp(&b_len_diff)
                })
                .then_with(|| a.2.word.cmp(&b.2.word))
        });

        for (_, _, candidate) in ranked {
            if suggestions.contains(&candidate.word) {
                continue;
            }
            suggestions.push(candidate.word.clone());
            if suggestions.len() == limit {
                break;
            }
        }

        suggestions
    }

    fn autocomplete(&self, prefix: &str, limit: usize) -> Vec<String> {
        if prefix.is_empty() {
            return Vec::new();
        }
        let prefix = modern_khmer_key(prefix);
        let index = self
            .lookup_words
            .partition_point(|candidate| candidate.as_str() < prefix.as_str());
        let mut candidates: Vec<_> = self
            .lookup_words
            .iter()
            .skip(index)
            .take_while(|candidate| candidate.starts_with(&prefix))
            .filter(|candidate| {
                candidate.as_str() != prefix.as_str()
                    && !candidate.chars().any(|c| {
                        c.is_ascii_punctuation()
                            || c.is_whitespace()
                            || c.is_ascii_digit()
                            || c == '\u{17d4}'
                            || c == '\u{17d5}'
                            || ('\u{17e0}'..='\u{17e9}').contains(&c)
                    })
            })
            .map(|candidate| {
                (
                    self.completion_costs
                        .get(candidate)
                        .copied()
                        .unwrap_or(f32::MAX),
                    candidate.chars().count(),
                    candidate,
                )
            })
            .collect();
        candidates.sort_by(|left, right| {
            left.0
                .total_cmp(&right.0)
                .then_with(|| left.1.cmp(&right.1))
                .then_with(|| left.2.cmp(right.2))
        });
        candidates
            .into_iter()
            .take(limit)
            .map(|(_, _, candidate)| candidate.clone())
            .collect()
    }
}

#[derive(Clone)]
pub struct SegmentationRegistry {
    providers: Vec<Arc<dyn LanguageSegmenter>>,
}

impl SegmentationRegistry {
    pub fn new() -> Result<Self, String> {
        Ok(Self {
            providers: vec![Arc::new(KhmerProvider::new()?)],
        })
    }

    pub fn analyze_ranges(&self, request: AnalyzeRequest) -> Result<AnalyzeResponse, String> {
        let mut merged_tokens: Vec<EditorToken> = Vec::new();

        for chunk in request.chunks {
            let active_providers: Vec<_> = self.providers
                .iter()
                .filter(|provider| provider.supports(&chunk.text))
                .collect();

            if active_providers.is_empty() {
                continue;
            }

            // Build UTF-16 to byte offset lookup map in one linear pass
            let mut utf16_to_byte = vec![0; chunk.text.encode_utf16().count() + 1];
            let mut current_utf16 = 0;
            for (byte_offset, character) in chunk.text.char_indices() {
                let len_u16 = character.len_utf16();
                utf16_to_byte[current_utf16] = byte_offset;
                if len_u16 > 1 {
                    utf16_to_byte[current_utf16 + 1] = byte_offset;
                }
                current_utf16 += len_u16;
            }
            utf16_to_byte[current_utf16] = chunk.text.len();

            let get_byte_range = |from: usize, to: usize, map: &[usize]| -> std::ops::Range<usize> {
                let start = map.get(from).copied().unwrap_or(0);
                let end = map.get(to).copied().unwrap_or(0);
                start..end
            };

            let default_provider = active_providers[0];
            let analysis = default_provider.analyze(&chunk.text)?;
            let mut chunk_tokens: Vec<EditorToken> = analysis
                .tokens
                .iter()
                .map(|token| {
                    let range = get_byte_range(token.from, token.to, &utf16_to_byte);
                    let source_text = chunk.text[range].to_owned();
                    EditorToken {
                        provider: default_provider.id().to_owned(),
                        source_from_utf16: token.from + chunk.start_utf16,
                        source_to_utf16: token.to + chunk.start_utf16,
                        source_text,
                        normalized_text: token.text.clone(),
                        known: token.known,
                        known_prefix: token.known_prefix,
                        hyphenated: token.hyphenated.clone(),
                    }
                })
                .collect();

            for provider in active_providers.iter().skip(1) {
                let analysis = provider.analyze(&chunk.text)?;
                for token in analysis.tokens {
                    let range = get_byte_range(token.from, token.to, &utf16_to_byte);
                    let source_text = chunk.text[range].to_owned();
                    if provider.supports(&source_text) {
                        let from_adjusted = token.from + chunk.start_utf16;
                        let to_adjusted = token.to + chunk.start_utf16;

                        chunk_tokens.retain(|existing| {
                            existing.source_to_utf16 <= from_adjusted
                                || existing.source_from_utf16 >= to_adjusted
                        });

                        chunk_tokens.push(EditorToken {
                            provider: provider.id().to_owned(),
                            source_from_utf16: from_adjusted,
                            source_to_utf16: to_adjusted,
                            source_text,
                            normalized_text: token.text.clone(),
                            known: token.known,
                            known_prefix: token.known_prefix,
                            hyphenated: token.hyphenated.clone(),
                        });
                    }
                }
            }

            chunk_tokens.sort_by_key(|t| t.source_from_utf16);
            merged_tokens.extend(chunk_tokens);
        }

        Ok(AnalyzeResponse {
            tokens: merged_tokens,
        })
    }
}

#[tauri::command]
pub fn get_provider_capabilities(
    registry: tauri::State<'_, SegmentationRegistry>,
) -> Vec<ProviderCapabilities> {
    registry
        .providers
        .iter()
        .map(|provider| ProviderCapabilities {
            id: provider.id().to_owned(),
            pattern: provider.pattern().to_owned(),
        })
        .collect()
}

#[tauri::command]
pub async fn analyze_language_ranges(
    registry: tauri::State<'_, SegmentationRegistry>,
    request: AnalyzeRequest,
) -> Result<AnalyzeResponse, String> {
    let registry = registry.inner().clone();
    tokio::task::spawn_blocking(move || registry.analyze_ranges(request))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn language_suggestions(
    registry: tauri::State<'_, SegmentationRegistry>,
    request: SuggestionRequest,
) -> Result<SuggestionResponse, String> {
    let providers = registry.providers.clone();
    tokio::task::spawn_blocking(move || {
        let provider = providers.iter().find(|p| p.id() == request.provider);
        let suggestions = if let Some(provider) = provider {
            provider.suggestions(&request.word, request.limit.min(50))
        } else {
            Vec::new()
        };
        Ok(SuggestionResponse { suggestions })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn complete_language_word(
    registry: tauri::State<'_, SegmentationRegistry>,
    request: CompletionRequest,
) -> Result<Option<CompletionResponse>, String> {
    let providers = registry.providers.clone();
    tokio::task::spawn_blocking(move || -> Result<Option<CompletionResponse>, String> {
        let Some(provider) = providers
            .iter()
            .find(|provider| provider.id() == request.provider)
        else {
            return Ok(None);
        };
        complete_with_provider(provider.as_ref(), &request)
    })
    .await
    .map_err(|error| error.to_string())?
}

fn complete_with_provider(
    provider: &dyn LanguageSegmenter,
    request: &CompletionRequest,
) -> Result<Option<CompletionResponse>, String> {
    let analysis = provider.analyze(&request.text)?;
    let Some(end_index) = analysis
        .tokens
        .iter()
        .rposition(|token| token.from < request.cursor_utf16 && token.to == request.cursor_utf16)
    else {
        return Ok(None);
    };
    // Khmer compounds can be segmented into an already-known word plus the
    // newly typed suffix. Try the longest recent token sequence first so a
    // prefix such as `សាលា` + `រ` remains `សាលារ`, not merely `រ`.
    let first_index = end_index.saturating_sub(3);
    for start_index in first_index..=end_index {
        let prefix = analysis.tokens[start_index..=end_index]
            .iter()
            .map(|token| token.text.as_str())
            .collect::<String>();
        let options = provider.autocomplete(&prefix, request.limit.min(50));
        if !options.is_empty() {
            return Ok(Some(CompletionResponse {
                provider: provider.id().to_owned(),
                from: analysis.tokens[start_index].from,
                to: request.cursor_utf16,
                options,
            }));
        }
    }
    Ok(None)
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refreshes_and_ranks_school_completion_for_each_prefix() {
        let provider = KhmerProvider::new().unwrap();
        for prefix in ["ស", "សា", "សាល", "សាលា", "សាលារ"] {
            let response = complete_with_provider(
                &provider,
                &CompletionRequest {
                    provider: "khmer-segmenter".to_string(),
                    text: prefix.into(),
                    cursor_utf16: prefix.encode_utf16().count(),
                    limit: 10,
                },
            )
            .unwrap()
            .expect("completion response");
            assert!(!response.options.iter().any(|option| option == prefix));
        }
        let response = complete_with_provider(
            &provider,
            &CompletionRequest {
                provider: "khmer-segmenter".to_string(),
                text: "សាលា".into(),
                cursor_utf16: "សាលា".encode_utf16().count(),
                limit: 10,
            },
        )
        .unwrap()
        .expect("school completion");
        assert_eq!(
            response.options.first().map(String::as_str),
            Some("សាលារៀន")
        );
        let continued = complete_with_provider(
            &provider,
            &CompletionRequest {
                provider: "khmer-segmenter".to_string(),
                text: "សាលារ".into(),
                cursor_utf16: "សាលារ".encode_utf16().count(),
                limit: 10,
            },
        )
        .unwrap()
        .expect("continued school completion");
        assert_eq!(continued.from, 0);
        assert_eq!(
            continued.options.first().map(String::as_str),
            Some("សាលារៀន")
        );
    }

    #[test]
    fn analyzes_khmer_with_editor_safe_ranges() {
        let provider = KhmerProvider::new().expect("Khmer provider");
        let analysis = provider.analyze("ក្រុមហ៊ុនទទួលបានប្រាក់ចំណូល").expect("analysis");
        assert!(!analysis.normalized_changed);
        assert!(!analysis.tokens.is_empty());
        assert!(analysis.tokens.iter().all(|token| token.from <= token.to));
    }

    #[test]
    fn preserves_source_ranges_through_normalization_and_utf16_conversion() {
        let provider = KhmerProvider::new().expect("Khmer provider");
        let source = "\u{1f600}\u{1780}\u{17c6}\u{17b6}";
        let analysis = provider.analyze(source).expect("analysis");
        assert!(analysis.normalized_changed);
        let khmer_tokens: Vec<_> = analysis
            .tokens
            .iter()
            .filter(|token| {
                token
                    .text
                    .chars()
                    .any(|character| ('\u{1780}'..='\u{17ff}').contains(&character))
            })
            .collect();
        assert!(!khmer_tokens.is_empty());
        assert_eq!(khmer_tokens.first().unwrap().from, 2);
        assert_eq!(khmer_tokens.last().unwrap().to, 5);

        let composed = provider
            .analyze("\u{1f600}\u{1780}\u{17c1}\u{17b8}")
            .expect("composed vowel analysis");
        assert!(composed.normalized_changed);
        assert!(composed
            .tokens
            .iter()
            .any(|token| token.from == 2 && token.to == 5));
    }

    #[test]
    fn preserves_ranges_across_removed_joiners() {
        let provider = KhmerProvider::new().expect("Khmer provider");
        for joiner in ['\u{200b}', '\u{200c}', '\u{200d}'] {
            let source = format!("\u{1f600}\u{1780}{joiner}\u{17b6}");
            let analysis = provider.analyze(&source).expect("joiner analysis");
            assert!(analysis
                .tokens
                .iter()
                .any(|token| token.from == 2 && token.to == 5));
        }
    }

    #[test]
    fn treats_modern_coeng_ta_and_legacy_coeng_da_as_equivalent() {
        let provider = KhmerProvider::new().expect("Khmer provider");
        let legacy = "គ្របដណ\u{17d2}\u{178a}ប់";
        let modern = "គ្របដណ\u{17d2}\u{178f}ប់";
        assert_eq!(modern_khmer_key(legacy), modern);
        for spelling in [legacy, modern] {
            let analysis = provider.analyze(spelling).expect("analysis");
            assert!(analysis.tokens.iter().all(|token| token.known));
            assert_eq!(analysis.tokens.first().unwrap().from, 0);
            assert_eq!(
                analysis.tokens.last().unwrap().to,
                spelling.encode_utf16().count()
            );
        }
    }

    #[test]
    fn completes_the_last_segment_in_an_unspaced_run() {
        let provider = KhmerProvider::new().expect("Khmer provider");
        let prefix = provider
            .lookup_words
            .iter()
            .find_map(|word| {
                let prefix: String = word.chars().take(1).collect();
                (!prefix.is_empty() && !provider.known.contains(&prefix)).then_some(prefix)
            })
            .expect("completion prefix");
        let response = provider.lookup_words.iter().take(200).find_map(|first| {
            let text = format!("{first}{prefix}");
            let request = CompletionRequest {
                provider: "khmer-segmenter".to_string(),
                cursor_utf16: text.encode_utf16().count(),
                text,
                limit: 10,
            };
            complete_with_provider(&provider, &request)
                .expect("completion")
                .filter(|response| response.from == first.encode_utf16().count())
                .map(|response| (first, response))
        });
        let (first, _) =
            response.expect("no dictionary pair produced a segmented suffix completion");
        let punctuated = format!("{first}\u{17d4}{prefix}");
        let response = complete_with_provider(
            &provider,
            &CompletionRequest {
                provider: "khmer-segmenter".to_string(),
                cursor_utf16: punctuated.encode_utf16().count(),
                text: punctuated,
                limit: 10,
            },
        )
        .expect("punctuated completion")
        .expect("completion after punctuation");
        assert_eq!(response.from, first.encode_utf16().count() + 1);
        assert!(!response.options.is_empty());
    }

    #[test]
    fn suggests_completions_for_an_unknown_dictionary_prefix() {
        let provider = KhmerProvider::new().expect("Khmer provider");
        let (prefix, full_word) = provider
            .lookup_words
            .iter()
            .find_map(|word| {
                let prefix: String = word.chars().take(1).collect();
                (!prefix.is_empty() && !provider.known.contains(&prefix))
                    .then(|| (prefix, word.clone()))
            })
            .expect("dictionary word with an unknown short prefix");
        assert!(provider
            .suggestions(&prefix, 10)
            .contains(&modern_khmer_key(&full_word)));
    }

    struct MockProvider;
    impl LanguageSegmenter for MockProvider {
        fn id(&self) -> &'static str {
            "mock-provider"
        }
        fn pattern(&self) -> &'static str {
            "[a-zA-Z]+"
        }
        fn supports(&self, text: &str) -> bool {
            text.chars().any(|c| c.is_ascii_alphabetic())
        }
        fn analyze(&self, text: &str) -> Result<TextAnalysis, String> {
            let mut tokens = Vec::new();
            let mut start = None;
            let mut current_utf16 = 0;
            for (index, character) in text.char_indices() {
                let is_alpha = character.is_ascii_alphabetic();
                match (start, is_alpha) {
                    (None, true) => start = Some((index, current_utf16)),
                    (Some((_from_byte, from_utf16)), false) => {
                        let word = &text[_from_byte..index];
                        tokens.push(SegmentToken {
                            text: word.to_string(),
                            from: from_utf16,
                            to: current_utf16,
                            known: word == "hello" || word == "world",
                            known_prefix: false,
                            hyphenated: None,
                        });
                        start = None;
                    }
                    _ => {}
                }
                current_utf16 += character.len_utf16();
            }
            if let Some((_from_byte, from_utf16)) = start {
                let word = &text[_from_byte..];
                tokens.push(SegmentToken {
                    text: word.to_string(),
                    from: from_utf16,
                    to: current_utf16,
                    known: word == "hello" || word == "world",
                    known_prefix: false,
                    hyphenated: None,
                });
            }
            Ok(TextAnalysis {
                provider: self.id(),
                normalized_changed: false,
                tokens,
            })
        }
        fn suggestions(&self, _word: &str, _limit: usize) -> Vec<String> {
            vec!["hello".to_string(), "world".to_string()]
        }
    }

    #[test]
    fn test_khmer_hyphenation_lookup() {
        let provider = KhmerProvider::new().unwrap();
        let analysis = provider.analyze("សាលារៀន").unwrap();
        assert!(!analysis.tokens.is_empty());
        
        let words_with_hyphens: Vec<_> = analysis.tokens.iter()
            .filter(|t| t.hyphenated.is_some())
            .collect();
        
        // Let's assert that at least one token has hyphenated representation
        assert!(!words_with_hyphens.is_empty(), "No hyphenated tokens found! Words analyzed: {:?}", analysis.tokens);
    }

    #[test]
    fn merges_tokens_from_multiple_providers() {
        use crate::segmentation::provider::{AnalyzeChunk, AnalyzeRequest};

        let registry = SegmentationRegistry {
            providers: vec![
                Arc::new(KhmerProvider::new().unwrap()),
                Arc::new(MockProvider),
            ],
        };

        let response = registry.analyze_ranges(
            AnalyzeRequest {
                chunks: vec![AnalyzeChunk {
                    text: "សាលារៀន hello invalidword".to_string(),
                    start_utf16: 0,
                }],
            },
        )
        .expect("analyze language ranges");

        assert!(!response.tokens.is_empty());
        let khmer_tokens: Vec<_> = response.tokens.iter().filter(|t| t.provider == "khmer-segmenter").collect();
        let mock_tokens: Vec<_> = response.tokens.iter().filter(|t| t.provider == "mock-provider").collect();

        assert!(!khmer_tokens.is_empty());
        assert!(!mock_tokens.is_empty());

        assert!(khmer_tokens.iter().any(|t| t.source_text == "សាលារៀន" && t.known));
        assert!(mock_tokens.iter().any(|t| t.source_text == "hello" && t.known));
        assert!(mock_tokens.iter().any(|t| t.source_text == "invalidword" && !t.known));
    }
}
