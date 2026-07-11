use super::provider::{
    AnalyzeRequest, AnalyzeResponse, CompletionRequest, CompletionResponse, EditorToken,
    LanguageSegmenter, ProviderCapabilities, ProviderFailure, SegmentToken, SuggestionRequest,
    SuggestionResponse, TextAnalysis, PROVIDER_CAPABILITY_SCHEMA_VERSION,
};
use crate::render_prepare::scanner::{scan_typst_content, ScanState};
use khmer_segmenter::kdict::{KDict, KHypDict};
use khmer_segmenter::{KhmerSegmenter, SegmenterConfig};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::RwLock;
use tauri::Manager;

const KHMER_DICTIONARY: &[u8] =
    include_bytes!("../../../third_party/khmer_segmenter/port/common/khmer_dictionary.kdict");
const KHMER_WORDS: &str = include_str!(
    "../../../third_party/khmer_segmenter/khmer_segmenter/dictionary_data/khmer_dictionary_words.txt"
);
const KHMER_HYPHENATION: &[u8] =
    include_bytes!("../../../third_party/khmer_segmenter/port/common/khmer_hyphenation.kdict");
const EN_US_AFF: &str = include_str!("../../resources/dictionaries/hunspell/en_US/en_US.aff");
const EN_US_DIC: &str = include_str!("../../resources/dictionaries/hunspell/en_US/en_US.dic");
const LIBREOFFICE_RAW_BASE: &str =
    "https://raw.githubusercontent.com/LibreOffice/dictionaries/master";

#[derive(Clone, Copy)]
struct HunspellCatalogSpec {
    locale: &'static str,
    display_name: &'static str,
    language_tag: &'static str,
    pattern: &'static str,
    aff_path: &'static str,
    dic_path: &'static str,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HunspellCatalogEntry {
    pub schema_version: u32,
    pub id: String,
    pub locale: String,
    pub display_name: String,
    pub language_tag: String,
    pub scripts: Vec<String>,
    pub installed: bool,
    pub bundled: bool,
    pub source: String,
    pub support_level: String,
    pub stability: String,
    pub boundary_mode: String,
    pub boundary_quality: String,
    pub correction_quality: String,
    pub supports_spellcheck: bool,
    pub supports_corrections: bool,
    pub supports_completion: bool,
    pub supports_segmentation: bool,
    pub supports_custom_dictionary: bool,
    pub has_editing_policy: bool,
}

const HUNSPELL_CATALOG: &[HunspellCatalogSpec] = &[
    HunspellCatalogSpec {
        locale: "ar",
        display_name: "Arabic",
        language_tag: "ar",
        pattern: "[\\u0600-\\u06FF\\u0750-\\u077F\\u08A0-\\u08FF][\\u0600-\\u06FF\\u0750-\\u077F\\u08A0-\\u08FF\\u064B-\\u065F'’\\-]*",
        aff_path: "ar/ar.aff",
        dic_path: "ar/ar.dic",
    },
    HunspellCatalogSpec {
        locale: "bn_BD",
        display_name: "Bengali (Bangladesh)",
        language_tag: "bn-BD",
        pattern: "[\\u0980-\\u09FF][\\u0980-\\u09FF'’\\-]*",
        aff_path: "bn_BD/bn_BD.aff",
        dic_path: "bn_BD/bn_BD.dic",
    },
    HunspellCatalogSpec {
        locale: "bo",
        display_name: "Tibetan",
        language_tag: "bo",
        pattern: "[\\u0F00-\\u0FFF][\\u0F00-\\u0FFF'’\\-]*",
        aff_path: "bo/bo.aff",
        dic_path: "bo/bo.dic",
    },
    HunspellCatalogSpec {
        locale: "gu_IN",
        display_name: "Gujarati",
        language_tag: "gu-IN",
        pattern: "[\\u0A80-\\u0AFF][\\u0A80-\\u0AFF'’\\-]*",
        aff_path: "gu_IN/gu_IN.aff",
        dic_path: "gu_IN/gu_IN.dic",
    },
    HunspellCatalogSpec {
        locale: "he_IL",
        display_name: "Hebrew",
        language_tag: "he-IL",
        pattern: "[\\u0590-\\u05FF][\\u0590-\\u05FF'’\\-]*",
        aff_path: "he_IL/he_IL.aff",
        dic_path: "he_IL/he_IL.dic",
    },
    HunspellCatalogSpec {
        locale: "hi_IN",
        display_name: "Hindi",
        language_tag: "hi-IN",
        pattern: "[\\u0900-\\u097F][\\u0900-\\u097F'’\\-]*",
        aff_path: "hi_IN/hi_IN.aff",
        dic_path: "hi_IN/hi_IN.dic",
    },
    HunspellCatalogSpec {
        locale: "lo_LA",
        display_name: "Lao",
        language_tag: "lo-LA",
        pattern: "[\\u0E80-\\u0EFF][\\u0E80-\\u0EFF'’\\-]*",
        aff_path: "lo_LA/lo_LA.aff",
        dic_path: "lo_LA/lo_LA.dic",
    },
    HunspellCatalogSpec {
        locale: "mr_IN",
        display_name: "Marathi",
        language_tag: "mr-IN",
        pattern: "[\\u0900-\\u097F][\\u0900-\\u097F'’\\-]*",
        aff_path: "mr_IN/mr_IN.aff",
        dic_path: "mr_IN/mr_IN.dic",
    },
    HunspellCatalogSpec {
        locale: "ne_NP",
        display_name: "Nepali",
        language_tag: "ne-NP",
        pattern: "[\\u0900-\\u097F][\\u0900-\\u097F'’\\-]*",
        aff_path: "ne_NP/ne_NP.aff",
        dic_path: "ne_NP/ne_NP.dic",
    },
    HunspellCatalogSpec {
        locale: "pa_IN",
        display_name: "Punjabi",
        language_tag: "pa-IN",
        pattern: "[\\u0A00-\\u0A7F][\\u0A00-\\u0A7F'’\\-]*",
        aff_path: "pa_IN/pa_IN.aff",
        dic_path: "pa_IN/pa_IN.dic",
    },
    HunspellCatalogSpec {
        locale: "si_LK",
        display_name: "Sinhala",
        language_tag: "si-LK",
        pattern: "[\\u0D80-\\u0DFF][\\u0D80-\\u0DFF'’\\-]*",
        aff_path: "si_LK/si_LK.aff",
        dic_path: "si_LK/si_LK.dic",
    },
    HunspellCatalogSpec {
        locale: "ta_IN",
        display_name: "Tamil",
        language_tag: "ta-IN",
        pattern: "[\\u0B80-\\u0BFF][\\u0B80-\\u0BFF'’\\-]*",
        aff_path: "ta_IN/ta_IN.aff",
        dic_path: "ta_IN/ta_IN.dic",
    },
    HunspellCatalogSpec {
        locale: "te_IN",
        display_name: "Telugu",
        language_tag: "te-IN",
        pattern: "[\\u0C00-\\u0C7F][\\u0C00-\\u0C7F'’\\-]*",
        aff_path: "te_IN/te_IN.aff",
        dic_path: "te_IN/te_IN.dic",
    },
    HunspellCatalogSpec {
        locale: "th_TH",
        display_name: "Thai",
        language_tag: "th-TH",
        pattern: "[\\u0E00-\\u0E7F][\\u0E00-\\u0E7F'’\\-]*",
        aff_path: "th_TH/th_TH.aff",
        dic_path: "th_TH/th_TH.dic",
    },
    HunspellCatalogSpec {
        locale: "vi_VN",
        display_name: "Vietnamese",
        language_tag: "vi-VN",
        pattern: "[\\p{Script=Latin}][\\p{Script=Latin}\\p{M}'’\\-]*",
        aff_path: "vi/vi_VN.aff",
        dic_path: "vi/vi_VN.dic",
    },
    HunspellCatalogSpec {
        locale: "en_GB",
        display_name: "English (UK)",
        language_tag: "en-GB",
        pattern: "[A-Za-z][A-Za-z'’\\-]*",
        aff_path: "en/en_GB.aff",
        dic_path: "en/en_GB.dic",
    },
    HunspellCatalogSpec {
        locale: "es_ES",
        display_name: "Spanish (Spain)",
        language_tag: "es-ES",
        pattern: "[\\p{Script=Latin}][\\p{Script=Latin}\\p{M}'’\\-]*",
        aff_path: "es/es_ES.aff",
        dic_path: "es/es_ES.dic",
    },
    HunspellCatalogSpec {
        locale: "fr_FR",
        display_name: "French",
        language_tag: "fr-FR",
        pattern: "[\\p{Script=Latin}][\\p{Script=Latin}\\p{M}'’\\-]*",
        aff_path: "fr_FR/dictionaries/fr.aff",
        dic_path: "fr_FR/dictionaries/fr.dic",
    },
    HunspellCatalogSpec {
        locale: "de_DE",
        display_name: "German (Germany)",
        language_tag: "de-DE",
        pattern: "[\\p{Script=Latin}][\\p{Script=Latin}\\p{M}'’\\-]*",
        aff_path: "de/de_DE_frami.aff",
        dic_path: "de/de_DE_frami.dic",
    },
    HunspellCatalogSpec {
        locale: "it_IT",
        display_name: "Italian",
        language_tag: "it-IT",
        pattern: "[\\p{Script=Latin}][\\p{Script=Latin}\\p{M}'’\\-]*",
        aff_path: "it_IT/it_IT.aff",
        dic_path: "it_IT/it_IT.dic",
    },
    HunspellCatalogSpec {
        locale: "pt_BR",
        display_name: "Portuguese (Brazil)",
        language_tag: "pt-BR",
        pattern: "[\\p{Script=Latin}][\\p{Script=Latin}\\p{M}'’\\-]*",
        aff_path: "pt_BR/pt_BR.aff",
        dic_path: "pt_BR/pt_BR.dic",
    },
];

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

    fn display_name(&self) -> &'static str {
        "Khmer"
    }

    fn language_tag(&self) -> &'static str {
        "km"
    }

    fn scripts(&self) -> &[&str] {
        &["Khmr"]
    }

    fn engine(&self) -> &'static str {
        "khmer_segmenter"
    }

    fn support_level(&self) -> &'static str {
        "deep"
    }

    fn stability(&self) -> &'static str {
        "experimental"
    }

    fn boundary_mode(&self) -> &'static str {
        "custom-segmenter"
    }

    fn boundary_quality(&self) -> &'static str {
        "dedicated"
    }

    fn supports_corrections(&self) -> bool {
        // TODO: Re-enable when Khmer analysis can return reliable intended-word
        // spans instead of unknown fragments inside an unspaced run.
        false
    }

    fn supports_completion(&self) -> bool {
        true
    }

    fn supports_segmentation(&self) -> bool {
        true
    }

    fn has_editing_policy(&self) -> bool {
        true
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
                let hyphenated = self
                    .hyphenation
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

    fn is_known_word(&self, word: &str) -> bool {
        self.known.contains(&modern_khmer_key(word))
    }
}

struct EnglishHunspellProvider {
    dictionary: spellbook::Dictionary,
    completion_words: Vec<String>,
    known_stems: HashSet<String>,
}

struct GenericHunspellProvider {
    id: &'static str,
    display_name: &'static str,
    language_tag: &'static str,
    scripts: Vec<&'static str>,
    pattern: &'static str,
    dictionary: spellbook::Dictionary,
    completion_words: Vec<String>,
    known_stems: HashSet<String>,
}

impl GenericHunspellProvider {
    fn new(
        locale: &str,
        display_name: &str,
        language_tag: &str,
        pattern: &str,
        aff: &str,
        dic: &str,
    ) -> Result<Self, String> {
        let dictionary = spellbook::Dictionary::new(aff, dic)
            .map_err(|error| format!("Failed to load {locale} dictionary: {error}"))?;
        let mut completion_words: Vec<String> = dic
            .lines()
            .skip(1)
            .filter_map(hunspell_dic_stem)
            .filter(|word| is_generic_completion_word(word))
            .map(normalize_generic_word)
            .collect();
        completion_words.sort();
        completion_words.dedup();
        let known_stems = completion_words.iter().cloned().collect();
        Ok(Self {
            id: Box::leak(format!("hunspell:{locale}").into_boxed_str()),
            display_name: Box::leak(display_name.to_owned().into_boxed_str()),
            language_tag: Box::leak(language_tag.to_owned().into_boxed_str()),
            scripts: vec![script_for_language_tag(language_tag)],
            pattern: Box::leak(pattern.to_owned().into_boxed_str()),
            dictionary,
            completion_words,
            known_stems,
        })
    }

    fn push_token(
        &self,
        text: &str,
        from_byte: usize,
        to_byte: usize,
        from_utf16: usize,
        to_utf16: usize,
        tokens: &mut Vec<SegmentToken>,
    ) {
        let word = &text[from_byte..to_byte];
        if word.chars().count() <= 1
            || !word
                .chars()
                .any(|character| character_matches_language_tag(character, self.language_tag))
            || should_skip_generic_token(text, from_byte, to_byte)
        {
            return;
        }
        let normalized = normalize_generic_word(word);
        let known = self.dictionary.check(word) || self.dictionary.check(&normalized);
        tokens.push(SegmentToken {
            text: normalized.clone(),
            from: from_utf16,
            to: to_utf16,
            known,
            known_prefix: known || self.has_prefix(&normalized),
            hyphenated: None,
        });
    }

    fn has_prefix(&self, prefix: &str) -> bool {
        let prefix = normalize_generic_word(prefix);
        if prefix.chars().count() < 2 {
            return false;
        }
        let index = self
            .completion_words
            .partition_point(|candidate| candidate.as_str() < prefix.as_str());
        self.completion_words
            .get(index)
            .is_some_and(|candidate| candidate.starts_with(&prefix))
    }
}

impl LanguageSegmenter for GenericHunspellProvider {
    fn id(&self) -> &'static str {
        self.id
    }

    fn display_name(&self) -> &'static str {
        self.display_name
    }

    fn language_tag(&self) -> &'static str {
        self.language_tag
    }

    fn scripts(&self) -> &[&str] {
        &self.scripts
    }

    fn engine(&self) -> &'static str {
        "spellbook"
    }

    fn support_level(&self) -> &'static str {
        "basic"
    }

    fn boundary_mode(&self) -> &'static str {
        "unicode-word"
    }

    fn pattern(&self) -> &'static str {
        self.pattern
    }

    fn supports(&self, text: &str) -> bool {
        text.chars()
            .any(|character| character_matches_language_tag(character, self.language_tag))
    }

    fn analyze(&self, text: &str) -> Result<TextAnalysis, String> {
        let mut tokens = Vec::new();
        let mut start = None::<(usize, usize)>;
        let mut current_utf16 = 0;
        for (byte_index, character) in text.char_indices() {
            let is_word = is_generic_token_char(character);
            match (start, is_word) {
                (None, true) => start = Some((byte_index, current_utf16)),
                (Some((from_byte, from_utf16)), false) => {
                    self.push_token(
                        text,
                        from_byte,
                        byte_index,
                        from_utf16,
                        current_utf16,
                        &mut tokens,
                    );
                    start = None;
                }
                _ => {}
            }
            current_utf16 += character.len_utf16();
        }
        if let Some((from_byte, from_utf16)) = start {
            self.push_token(
                text,
                from_byte,
                text.len(),
                from_utf16,
                current_utf16,
                &mut tokens,
            );
        }
        Ok(TextAnalysis {
            provider: self.id(),
            normalized_changed: false,
            tokens,
        })
    }

    fn suggestions(&self, word: &str, limit: usize) -> Vec<String> {
        if word.trim().is_empty() || limit == 0 {
            return Vec::new();
        }
        let mut output = Vec::new();
        self.dictionary.suggest(word, &mut output);
        output.truncate(limit);
        output
    }

    fn is_known_word(&self, word: &str) -> bool {
        self.dictionary.check(word) || self.known_stems.contains(&normalize_generic_word(word))
    }

    fn autocomplete(&self, prefix: &str, limit: usize) -> Vec<String> {
        if limit == 0 {
            return Vec::new();
        }
        let normalized = normalize_generic_word(prefix);
        if normalized.chars().count() < 2 {
            return Vec::new();
        }
        let index = self
            .completion_words
            .partition_point(|candidate| candidate.as_str() < normalized.as_str());
        self.completion_words
            .iter()
            .skip(index)
            .take_while(|candidate| candidate.starts_with(&normalized))
            .filter(|candidate| candidate.as_str() != normalized.as_str())
            .take(limit)
            .cloned()
            .collect()
    }
}

impl EnglishHunspellProvider {
    fn new() -> Result<Self, String> {
        let dictionary = spellbook::Dictionary::new(EN_US_AFF, EN_US_DIC)
            .map_err(|error| format!("Failed to load en_US dictionary: {error}"))?;
        let mut completion_words: Vec<String> = EN_US_DIC
            .lines()
            .skip(1)
            .filter_map(hunspell_dic_stem)
            .filter(|word| is_completion_word(word))
            .map(|word| word.to_ascii_lowercase())
            .collect();
        completion_words.sort();
        completion_words.dedup();
        let known_stems = completion_words.iter().cloned().collect();
        Ok(Self {
            dictionary,
            completion_words,
            known_stems,
        })
    }

    fn has_prefix(&self, prefix: &str) -> bool {
        let prefix = normalize_english_word(prefix);
        if prefix.len() < 2 {
            return false;
        }
        let index = self
            .completion_words
            .partition_point(|candidate| candidate.as_str() < prefix.as_str());
        self.completion_words
            .get(index)
            .is_some_and(|candidate| candidate.starts_with(&prefix))
    }

    fn should_skip_token(&self, text: &str, from: usize, to: usize) -> bool {
        let word = &text[from..to];
        if word.len() <= 1 || word.chars().all(|c| c.is_ascii_uppercase()) {
            return true;
        }
        if word.contains('_') || word.chars().any(|c| c.is_ascii_digit()) {
            return true;
        }
        if word.chars().any(|c| c.is_ascii_uppercase())
            && !is_title_case_word(word)
            && !word.chars().all(|c| c.is_ascii_uppercase())
        {
            return true;
        }
        let previous = text[..from].chars().next_back();
        if matches!(previous, Some('#' | '@' | '_' | '\\')) {
            return true;
        }
        if matches!(previous, Some('.')) && text[..from].ends_with("..") {
            return true;
        }
        let next = text[to..].chars().next();
        if matches!(next, Some('@')) || looks_like_url_context(text, from, to) {
            return true;
        }
        if is_inside_typst_code_string(text, from, to) {
            return true;
        }
        false
    }
}

impl LanguageSegmenter for EnglishHunspellProvider {
    fn id(&self) -> &'static str {
        "hunspell:en_US"
    }

    fn display_name(&self) -> &'static str {
        "English (US)"
    }

    fn language_tag(&self) -> &'static str {
        "en-US"
    }

    fn scripts(&self) -> &[&str] {
        &["Latn"]
    }

    fn engine(&self) -> &'static str {
        "spellbook"
    }

    fn support_level(&self) -> &'static str {
        "enhanced"
    }

    fn boundary_mode(&self) -> &'static str {
        "unicode-word"
    }

    fn boundary_quality(&self) -> &'static str {
        "tested"
    }

    fn supports_completion(&self) -> bool {
        true
    }

    fn pattern(&self) -> &'static str {
        "[A-Za-z][A-Za-z'’\\-]*"
    }

    fn supports(&self, text: &str) -> bool {
        text.chars()
            .any(|character| character.is_ascii_alphabetic())
    }

    fn analyze(&self, text: &str) -> Result<TextAnalysis, String> {
        let mut tokens = Vec::new();
        let mut start = None::<(usize, usize)>;
        let mut current_utf16 = 0;
        for (byte_index, character) in text.char_indices() {
            let is_word = is_english_token_char(character);
            match (start, is_word) {
                (None, true) => start = Some((byte_index, current_utf16)),
                (Some((from_byte, from_utf16)), false) => {
                    self.push_token(
                        text,
                        from_byte,
                        byte_index,
                        from_utf16,
                        current_utf16,
                        &mut tokens,
                    );
                    start = None;
                }
                _ => {}
            }
            current_utf16 += character.len_utf16();
        }
        if let Some((from_byte, from_utf16)) = start {
            self.push_token(
                text,
                from_byte,
                text.len(),
                from_utf16,
                current_utf16,
                &mut tokens,
            );
        }
        Ok(TextAnalysis {
            provider: self.id(),
            normalized_changed: false,
            tokens,
        })
    }

    fn suggestions(&self, word: &str, limit: usize) -> Vec<String> {
        if word.trim().is_empty() || limit == 0 {
            return Vec::new();
        }
        let mut output = Vec::new();
        self.dictionary.suggest(word, &mut output);
        output.truncate(limit);
        output
    }

    fn is_known_word(&self, word: &str) -> bool {
        self.dictionary.check(word) || self.known_stems.contains(&normalize_english_word(word))
    }

    fn autocomplete(&self, prefix: &str, limit: usize) -> Vec<String> {
        if limit == 0 {
            return Vec::new();
        }
        let normalized = normalize_english_word(prefix);
        if normalized.len() < 2 {
            return Vec::new();
        }
        let index = self
            .completion_words
            .partition_point(|candidate| candidate.as_str() < normalized.as_str());
        self.completion_words
            .iter()
            .skip(index)
            .take_while(|candidate| candidate.starts_with(&normalized))
            .filter(|candidate| candidate.as_str() != normalized.as_str())
            .take(limit)
            .map(|candidate| apply_english_casing(prefix, candidate))
            .collect()
    }
}

impl EnglishHunspellProvider {
    fn push_token(
        &self,
        text: &str,
        from_byte: usize,
        to_byte: usize,
        from_utf16: usize,
        to_utf16: usize,
        tokens: &mut Vec<SegmentToken>,
    ) {
        let original_from_byte = from_byte;
        let original_to_byte = to_byte;
        let (trimmed_from_byte, trimmed_to_byte) = trim_english_token(text, from_byte, to_byte);
        if trimmed_from_byte >= trimmed_to_byte
            || self.should_skip_token(text, trimmed_from_byte, trimmed_to_byte)
        {
            return;
        }
        let word = &text[trimmed_from_byte..trimmed_to_byte];
        let normalized = normalize_english_word(word);
        let trim_start_utf16 = text[original_from_byte..trimmed_from_byte]
            .encode_utf16()
            .count();
        let trim_end_utf16 = text[trimmed_to_byte..original_to_byte]
            .encode_utf16()
            .count();
        let known = self.dictionary.check(word) || self.dictionary.check(&normalized);
        tokens.push(SegmentToken {
            text: normalized.clone(),
            from: from_utf16 + trim_start_utf16,
            to: to_utf16 - trim_end_utf16,
            known,
            known_prefix: known || self.has_prefix(&normalized),
            hyphenated: None,
        });
    }
}

fn hunspell_dic_stem(line: &str) -> Option<&str> {
    let value = line.trim();
    if value.is_empty() || value.starts_with('#') {
        return None;
    }
    let stem = value
        .split_once('/')
        .map(|(stem, _)| stem)
        .unwrap_or(value)
        .split_whitespace()
        .next()
        .unwrap_or("");
    (!stem.is_empty()).then_some(stem)
}

fn is_completion_word(word: &str) -> bool {
    word.len() >= 2
        && word
            .chars()
            .all(|c| c.is_ascii_alphabetic() || matches!(c, '\'' | '’' | '-'))
        && word.chars().any(|c| c.is_ascii_alphabetic())
}

fn is_generic_completion_word(word: &str) -> bool {
    word.chars().count() >= 2
        && word
            .chars()
            .all(|c| c.is_alphabetic() || matches!(c, '\'' | '’' | '-'))
        && word.chars().any(char::is_alphabetic)
}

fn is_generic_token_char(character: char) -> bool {
    character.is_alphabetic() || matches!(character, '\'' | '’' | '-')
}

fn normalize_generic_word(word: &str) -> String {
    word.to_lowercase()
}

fn character_matches_language_tag(character: char, language_tag: &str) -> bool {
    let language = language_tag.split('-').next().unwrap_or(language_tag);
    match language {
        "ar" => {
            ('\u{0600}'..='\u{06ff}').contains(&character)
                || ('\u{0750}'..='\u{077f}').contains(&character)
                || ('\u{08a0}'..='\u{08ff}').contains(&character)
        }
        "bn" => ('\u{0980}'..='\u{09ff}').contains(&character),
        "bo" => ('\u{0f00}'..='\u{0fff}').contains(&character),
        "gu" => ('\u{0a80}'..='\u{0aff}').contains(&character),
        "he" => ('\u{0590}'..='\u{05ff}').contains(&character),
        "hi" | "mr" | "ne" => ('\u{0900}'..='\u{097f}').contains(&character),
        "lo" => ('\u{0e80}'..='\u{0eff}').contains(&character),
        "pa" => ('\u{0a00}'..='\u{0a7f}').contains(&character),
        "si" => ('\u{0d80}'..='\u{0dff}').contains(&character),
        "ta" => ('\u{0b80}'..='\u{0bff}').contains(&character),
        "te" => ('\u{0c00}'..='\u{0c7f}').contains(&character),
        "th" => ('\u{0e00}'..='\u{0e7f}').contains(&character),
        _ => {
            character.is_alphabetic()
                && (character.is_ascii()
                    || ('\u{00c0}'..='\u{024f}').contains(&character)
                    || ('\u{1e00}'..='\u{1eff}').contains(&character))
        }
    }
}

fn script_for_language_tag(language_tag: &str) -> &'static str {
    match language_tag.split('-').next().unwrap_or(language_tag) {
        "ar" => "Arab",
        "bn" => "Beng",
        "bo" => "Tibt",
        "gu" => "Gujr",
        "he" => "Hebr",
        "hi" | "mr" | "ne" => "Deva",
        "lo" => "Laoo",
        "pa" => "Guru",
        "si" => "Sinh",
        "ta" => "Taml",
        "te" => "Telu",
        "th" => "Thai",
        _ => "Latn",
    }
}

fn should_skip_generic_token(text: &str, from: usize, to: usize) -> bool {
    let word = &text[from..to];
    if word.contains('_') || word.chars().any(|c| c.is_ascii_digit()) {
        return true;
    }
    let previous = text[..from].chars().next_back();
    if matches!(previous, Some('#' | '@' | '_' | '\\')) {
        return true;
    }
    let next = text[to..].chars().next();
    matches!(next, Some('@')) || looks_like_url_context(text, from, to)
}

fn hunspell_install_root(data_dir: &Path) -> PathBuf {
    data_dir.join("dictionaries").join("hunspell")
}

fn installed_hunspell_providers(data_dir: &Path) -> Result<Vec<GenericHunspellProvider>, String> {
    let root = hunspell_install_root(data_dir);
    let mut providers = Vec::new();
    if !root.exists() {
        return Ok(providers);
    }
    for spec in HUNSPELL_CATALOG {
        let locale_dir = root.join(spec.locale);
        let aff_path = locale_dir.join(format!("{}.aff", spec.locale));
        let dic_path = locale_dir.join(format!("{}.dic", spec.locale));
        if !aff_path.exists() || !dic_path.exists() {
            continue;
        }
        let aff = std::fs::read_to_string(&aff_path)
            .map_err(|error| format!("Failed to read {}: {error}", aff_path.display()))?;
        let dic = std::fs::read_to_string(&dic_path)
            .map_err(|error| format!("Failed to read {}: {error}", dic_path.display()))?;
        providers.push(GenericHunspellProvider::new(
            spec.locale,
            spec.display_name,
            spec.language_tag,
            spec.pattern,
            &aff,
            &dic,
        )?);
    }
    Ok(providers)
}

fn find_hunspell_spec(locale: &str) -> Option<&'static HunspellCatalogSpec> {
    HUNSPELL_CATALOG
        .iter()
        .find(|spec| spec.locale.eq_ignore_ascii_case(locale))
}

fn is_hunspell_installed(data_dir: &Path, locale: &str) -> bool {
    let locale_dir = hunspell_install_root(data_dir).join(locale);
    locale_dir.join(format!("{locale}.aff")).exists()
        && locale_dir.join(format!("{locale}.dic")).exists()
}

fn catalog_entry(data_dir: Option<&Path>, spec: &HunspellCatalogSpec) -> HunspellCatalogEntry {
    HunspellCatalogEntry {
        schema_version: PROVIDER_CAPABILITY_SCHEMA_VERSION,
        id: format!("hunspell:{}", spec.locale),
        locale: spec.locale.to_string(),
        display_name: spec.display_name.to_string(),
        language_tag: spec.language_tag.to_string(),
        scripts: vec![script_for_language_tag(spec.language_tag).to_string()],
        installed: data_dir.is_some_and(|dir| is_hunspell_installed(dir, spec.locale)),
        bundled: false,
        source: "LibreOffice dictionaries".to_string(),
        support_level: "basic".to_string(),
        stability: "stable".to_string(),
        boundary_mode: "unicode-word".to_string(),
        boundary_quality: "general".to_string(),
        correction_quality: "dictionary".to_string(),
        supports_spellcheck: true,
        supports_corrections: true,
        supports_completion: false,
        supports_segmentation: false,
        supports_custom_dictionary: true,
        has_editing_policy: false,
    }
}

async fn download_text(url: &str, max_bytes: usize) -> Result<String, String> {
    let response = reqwest::get(url)
        .await
        .map_err(|error| format!("Failed to download {url}: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("{url} returned {status}"));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("Failed to read {url}: {error}"))?;
    if bytes.len() > max_bytes {
        return Err(format!("{url} is too large."));
    }
    String::from_utf8(bytes.to_vec()).map_err(|error| format!("{url} is not UTF-8: {error}"))
}

fn is_english_token_char(character: char) -> bool {
    character.is_ascii_alphabetic() || matches!(character, '\'' | '’' | '-')
}

fn trim_english_token(text: &str, mut from: usize, mut to: usize) -> (usize, usize) {
    while from < to {
        let Some(character) = text[from..to].chars().next() else {
            break;
        };
        if character.is_ascii_alphabetic() {
            break;
        }
        from += character.len_utf8();
    }
    while from < to {
        let Some(character) = text[from..to].chars().next_back() else {
            break;
        };
        if character.is_ascii_alphabetic() {
            break;
        }
        to -= character.len_utf8();
    }
    (from, to)
}

fn normalize_english_word(word: &str) -> String {
    word.replace('’', "'").to_ascii_lowercase()
}

fn apply_english_casing(prefix: &str, word: &str) -> String {
    if prefix.chars().all(|c| !c.is_ascii_lowercase()) {
        return word.to_ascii_uppercase();
    }
    if is_title_case_word(prefix) {
        let mut chars = word.chars();
        let Some(first) = chars.next() else {
            return String::new();
        };
        return format!("{}{}", first.to_ascii_uppercase(), chars.as_str());
    }
    word.to_string()
}

fn is_title_case_word(word: &str) -> bool {
    let mut chars = word.chars().filter(|c| c.is_ascii_alphabetic());
    let Some(first) = chars.next() else {
        return false;
    };
    first.is_ascii_uppercase() && chars.all(|c| c.is_ascii_lowercase())
}

fn looks_like_url_context(text: &str, from: usize, to: usize) -> bool {
    let line_start = text[..from].rfind('\n').map(|index| index + 1).unwrap_or(0);
    let line_end = text[to..]
        .find('\n')
        .map(|index| to + index)
        .unwrap_or(text.len());
    let line = &text[line_start..line_end];
    let local_from = from - line_start;
    let before = &line[..local_from];
    before.contains("://")
        || before.ends_with("www.")
        || before
            .rsplit_once(' ')
            .is_some_and(|(_, value)| value.contains("://"))
}

fn is_inside_typst_code_string(text: &str, from: usize, to: usize) -> bool {
    let line_start = text[..from].rfind('\n').map(|index| index + 1).unwrap_or(0);
    let line_end = text[to..]
        .find('\n')
        .map(|index| to + index)
        .unwrap_or(text.len());
    let line = &text[line_start..line_end];
    let local_from = from - line_start;
    let local_to = to - line_start;
    let before = &line[..local_from];
    let Some(open_quote) = last_unescaped_quote(before) else {
        return false;
    };
    let after = &line[local_to..];
    let Some(close_quote) = first_unescaped_quote(after) else {
        return false;
    };
    let after_close = after[close_quote + 1..].trim_start();
    before[..open_quote].contains('#') || after_close.starts_with([')', ',', ':', ']'])
}

fn last_unescaped_quote(text: &str) -> Option<usize> {
    text.char_indices()
        .filter(|(index, character)| *character == '"' && !is_escaped_at(text, *index))
        .map(|(index, _)| index)
        .last()
}

fn first_unescaped_quote(text: &str) -> Option<usize> {
    text.char_indices()
        .find(|(index, character)| *character == '"' && !is_escaped_at(text, *index))
        .map(|(index, _)| index)
}

fn is_escaped_at(text: &str, index: usize) -> bool {
    let mut count = 0;
    for character in text[..index].chars().rev() {
        if character != '\\' {
            break;
        }
        count += 1;
    }
    count % 2 == 1
}

#[derive(Clone)]
pub struct SegmentationRegistry {
    providers: Arc<RwLock<Vec<Arc<dyn LanguageSegmenter>>>>,
}

impl SegmentationRegistry {
    pub fn empty() -> Self {
        Self {
            providers: Arc::new(RwLock::new(Vec::new())),
        }
    }

    #[cfg(test)]
    pub fn new() -> Result<Self, String> {
        Self::new_with_data_dir(None)
    }

    #[cfg(test)]
    pub fn new_with_data_dir(data_dir: Option<&Path>) -> Result<Self, String> {
        let providers = Self::load_providers(data_dir)?;
        Ok(Self {
            providers: Arc::new(RwLock::new(providers)),
        })
    }

    pub fn reload_installed(&self, data_dir: &Path) -> Result<(), String> {
        let providers = Self::load_providers(Some(data_dir))?;
        *self
            .providers
            .write()
            .map_err(|_| "Language provider registry lock is poisoned.".to_string())? = providers;
        Ok(())
    }

    fn provider_snapshot(&self) -> Result<Vec<Arc<dyn LanguageSegmenter>>, String> {
        Ok(self
            .providers
            .read()
            .map_err(|_| "Language provider registry lock is poisoned.".to_string())?
            .clone())
    }

    pub fn provider_capabilities(&self) -> Result<Vec<ProviderCapabilities>, String> {
        Ok(self
            .provider_snapshot()?
            .iter()
            .map(|provider| ProviderCapabilities {
                schema_version: PROVIDER_CAPABILITY_SCHEMA_VERSION,
                id: provider.id().to_owned(),
                pattern: provider.pattern().to_owned(),
                display_name: provider.display_name().to_owned(),
                language_tag: provider.language_tag().to_owned(),
                scripts: provider
                    .scripts()
                    .iter()
                    .map(|script| (*script).to_owned())
                    .collect(),
                engine: provider.engine().to_owned(),
                support_level: provider.support_level().to_owned(),
                stability: provider.stability().to_owned(),
                boundary_mode: provider.boundary_mode().to_owned(),
                boundary_quality: provider.boundary_quality().to_owned(),
                correction_quality: provider.correction_quality().to_owned(),
                supports_spellcheck: provider.supports_spellcheck(),
                supports_corrections: provider.supports_corrections(),
                supports_completion: provider.supports_completion(),
                supports_segmentation: provider.supports_segmentation(),
                supports_custom_dictionary: provider.supports_custom_dictionary(),
                has_editing_policy: provider.has_editing_policy(),
            })
            .collect())
    }

    fn load_providers(data_dir: Option<&Path>) -> Result<Vec<Arc<dyn LanguageSegmenter>>, String> {
        let mut providers: Vec<Arc<dyn LanguageSegmenter>> = vec![
            Arc::new(KhmerProvider::new()?),
            Arc::new(EnglishHunspellProvider::new()?),
        ];
        if let Some(data_dir) = data_dir {
            for entry in installed_hunspell_providers(data_dir)? {
                providers.push(Arc::new(entry));
            }
        }
        Ok(providers)
    }

    pub fn analyze_ranges(&self, request: AnalyzeRequest) -> Result<AnalyzeResponse, String> {
        let providers = self.provider_snapshot()?;
        let mut candidates = Vec::<ProviderTokenCandidate>::new();
        let mut failures = Vec::<ProviderFailure>::new();
        let mut seen_failures = HashSet::<(String, usize, usize, String)>::new();

        for chunk in request.chunks {
            let byte_to_utf16 = byte_to_utf16_offsets(&chunk.text);
            for (state, span_from_byte, span_to_byte, _scope) in scan_typst_content(&chunk.text) {
                if state != ScanState::MarkupText || span_from_byte >= span_to_byte {
                    continue;
                }
                let span_text = &chunk.text[span_from_byte..span_to_byte];
                let span_start_utf16 = chunk.start_utf16 + byte_to_utf16[span_from_byte];
                let span_end_utf16 = span_start_utf16 + span_text.encode_utf16().count();
                let utf16_to_byte = utf16_to_byte_boundaries(span_text);

                for provider in providers
                    .iter()
                    .filter(|provider| provider.supports(span_text))
                {
                    let analysis = match provider.analyze(span_text) {
                        Ok(analysis) => analysis,
                        Err(message) => {
                            push_provider_failure(
                                &mut failures,
                                &mut seen_failures,
                                provider.id(),
                                span_start_utf16,
                                span_end_utf16,
                                message,
                            );
                            continue;
                        }
                    };

                    for token in analysis.tokens {
                        let Some(source_range) =
                            utf16_byte_range(&utf16_to_byte, token.from, token.to, span_text.len())
                        else {
                            push_provider_failure(
                                &mut failures,
                                &mut seen_failures,
                                provider.id(),
                                span_start_utf16,
                                span_end_utf16,
                                format!(
                                    "returned invalid UTF-16 token range {}..{} for a {}-unit span",
                                    token.from,
                                    token.to,
                                    utf16_to_byte.len().saturating_sub(1)
                                ),
                            );
                            continue;
                        };
                        let source_text = span_text[source_range].to_owned();
                        if source_text.is_empty() || !provider.supports(&source_text) {
                            continue;
                        }
                        candidates.push(ProviderTokenCandidate {
                            priority: provider_priority(provider.as_ref()),
                            provider_id: provider.id().to_owned(),
                            token: EditorToken {
                                provider: provider.id().to_owned(),
                                source_from_utf16: token.from + span_start_utf16,
                                source_to_utf16: token.to + span_start_utf16,
                                source_text,
                                normalized_text: token.text,
                                known: token.known,
                                known_prefix: token.known_prefix,
                                hyphenated: token.hyphenated,
                            },
                        });
                    }
                }
            }
        }

        Ok(AnalyzeResponse {
            tokens: merge_provider_tokens(candidates),
            failures,
        })
    }
}

struct ProviderTokenCandidate {
    priority: u8,
    provider_id: String,
    token: EditorToken,
}

fn provider_priority(provider: &dyn LanguageSegmenter) -> u8 {
    let support = match provider.support_level() {
        "deep" => 30,
        "enhanced" => 20,
        _ => 10,
    };
    let boundary = match provider.boundary_quality() {
        "dedicated" => 3,
        "tested" => 2,
        _ => 1,
    };
    support + boundary
}

fn merge_provider_tokens(mut candidates: Vec<ProviderTokenCandidate>) -> Vec<EditorToken> {
    candidates.sort_by(|left, right| {
        right
            .priority
            .cmp(&left.priority)
            .then_with(|| left.provider_id.cmp(&right.provider_id))
            .then_with(|| {
                left.token
                    .source_from_utf16
                    .cmp(&right.token.source_from_utf16)
            })
            .then_with(|| left.token.source_to_utf16.cmp(&right.token.source_to_utf16))
    });
    let mut accepted = Vec::<EditorToken>::new();
    for candidate in candidates {
        if accepted.iter().any(|existing| {
            existing.source_from_utf16 < candidate.token.source_to_utf16
                && candidate.token.source_from_utf16 < existing.source_to_utf16
        }) {
            continue;
        }
        accepted.push(candidate.token);
    }
    accepted.sort_by(|left, right| {
        left.source_from_utf16
            .cmp(&right.source_from_utf16)
            .then_with(|| left.source_to_utf16.cmp(&right.source_to_utf16))
            .then_with(|| left.provider.cmp(&right.provider))
    });
    accepted
}

fn push_provider_failure(
    failures: &mut Vec<ProviderFailure>,
    seen: &mut HashSet<(String, usize, usize, String)>,
    provider: &str,
    source_from_utf16: usize,
    source_to_utf16: usize,
    message: String,
) {
    let key = (
        provider.to_owned(),
        source_from_utf16,
        source_to_utf16,
        message.clone(),
    );
    if !seen.insert(key) {
        return;
    }
    failures.push(ProviderFailure {
        provider: provider.to_owned(),
        operation: "analyze".to_string(),
        source_from_utf16,
        source_to_utf16,
        message,
    });
}

fn utf16_to_byte_boundaries(text: &str) -> Vec<Option<usize>> {
    let mut map = vec![None; text.encode_utf16().count() + 1];
    let mut utf16_offset = 0;
    for (byte_offset, character) in text.char_indices() {
        map[utf16_offset] = Some(byte_offset);
        utf16_offset += character.len_utf16();
    }
    map[utf16_offset] = Some(text.len());
    map
}

fn utf16_byte_range(
    map: &[Option<usize>],
    from: usize,
    to: usize,
    text_len: usize,
) -> Option<std::ops::Range<usize>> {
    if from >= to {
        return None;
    }
    let start = map.get(from).copied().flatten()?;
    let end = map.get(to).copied().flatten()?;
    (start < end && end <= text_len).then_some(start..end)
}

fn byte_to_utf16_offsets(text: &str) -> Vec<usize> {
    let mut map = vec![0; text.len() + 1];
    let mut utf16_offset = 0;
    for (byte_offset, character) in text.char_indices() {
        for offset in byte_offset..byte_offset + character.len_utf8() {
            map[offset] = utf16_offset;
        }
        utf16_offset += character.len_utf16();
    }
    map[text.len()] = utf16_offset;
    map
}

#[tauri::command]
pub fn get_provider_capabilities(
    registry: tauri::State<'_, SegmentationRegistry>,
) -> Result<Vec<ProviderCapabilities>, String> {
    registry.provider_capabilities()
}

#[tauri::command]
pub fn list_hunspell_catalog(
    app_handle: tauri::AppHandle,
) -> Result<Vec<HunspellCatalogEntry>, String> {
    let data_dir = app_handle
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("Failed to locate app data directory: {error}"))?;
    let mut entries = vec![HunspellCatalogEntry {
        schema_version: PROVIDER_CAPABILITY_SCHEMA_VERSION,
        id: "hunspell:en_US".to_string(),
        locale: "en_US".to_string(),
        display_name: "English (US)".to_string(),
        language_tag: "en-US".to_string(),
        scripts: vec!["Latn".to_string()],
        installed: true,
        bundled: true,
        source: "Bundled with Typstry".to_string(),
        support_level: "enhanced".to_string(),
        stability: "stable".to_string(),
        boundary_mode: "unicode-word".to_string(),
        boundary_quality: "tested".to_string(),
        correction_quality: "dictionary".to_string(),
        supports_spellcheck: true,
        supports_corrections: true,
        supports_completion: true,
        supports_segmentation: false,
        supports_custom_dictionary: true,
        has_editing_policy: false,
    }];
    entries.extend(
        HUNSPELL_CATALOG
            .iter()
            .map(|spec| catalog_entry(Some(&data_dir), spec)),
    );
    Ok(entries)
}

#[tauri::command]
pub async fn install_hunspell_dictionary(
    app_handle: tauri::AppHandle,
    registry: tauri::State<'_, SegmentationRegistry>,
    locale: String,
) -> Result<Vec<ProviderCapabilities>, String> {
    let spec = find_hunspell_spec(&locale)
        .ok_or_else(|| format!("{locale} is not in Typstry's Hunspell catalog."))?;
    let aff_url = format!("{LIBREOFFICE_RAW_BASE}/{}", spec.aff_path);
    let dic_url = format!("{LIBREOFFICE_RAW_BASE}/{}", spec.dic_path);
    let (aff, dic) = tokio::try_join!(
        download_text(&aff_url, 8 * 1024 * 1024),
        download_text(&dic_url, 32 * 1024 * 1024)
    )?;
    GenericHunspellProvider::new(
        spec.locale,
        spec.display_name,
        spec.language_tag,
        spec.pattern,
        &aff,
        &dic,
    )?;

    let data_dir = app_handle
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("Failed to locate app data directory: {error}"))?;
    let locale_dir = hunspell_install_root(&data_dir).join(spec.locale);
    std::fs::create_dir_all(&locale_dir)
        .map_err(|error| format!("Failed to create {}: {error}", locale_dir.display()))?;
    std::fs::write(locale_dir.join(format!("{}.aff", spec.locale)), aff)
        .map_err(|error| format!("Failed to write {} dictionary .aff: {error}", spec.locale))?;
    std::fs::write(locale_dir.join(format!("{}.dic", spec.locale)), dic)
        .map_err(|error| format!("Failed to write {} dictionary .dic: {error}", spec.locale))?;

    registry.reload_installed(&data_dir)?;
    get_provider_capabilities(registry)
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
    let providers = registry.provider_snapshot()?;
    tokio::task::spawn_blocking(move || {
        let provider = providers.iter().find(|p| p.id() == request.provider);
        let suggestions = if let Some(provider) = provider {
            if provider.supports_corrections() {
                provider.suggestions(&request.word, request.limit.min(50))
            } else {
                Vec::new()
            }
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
    let providers = registry.provider_snapshot()?;
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
    if !provider.supports_completion() {
        return Ok(None);
    }
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
        let limit = request.limit.min(50);
        let mut options = provider.autocomplete(&prefix, limit);
        if provider.is_known_word(&prefix) && !options.iter().any(|option| option == &prefix) {
            options.insert(0, prefix);
            options.truncate(limit);
        }
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

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct KhmerReferenceFixture {
        fixture_version: u32,
        upstream_commit: String,
        segmentation: Vec<KhmerSegmentationFixture>,
        normalization: Vec<KhmerNormalizationFixture>,
        completion: Vec<KhmerCompletionFixture>,
    }

    #[derive(serde::Deserialize)]
    struct KhmerSegmentationFixture {
        name: String,
        input: String,
        tokens: Vec<KhmerTokenFixture>,
    }

    #[derive(Debug, PartialEq, serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct KhmerTokenFixture {
        normalized: String,
        source: String,
        from: usize,
        to: usize,
        known: bool,
        #[serde(default)]
        known_prefix: Option<bool>,
    }

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct KhmerNormalizationFixture {
        name: String,
        input: String,
        normalized: String,
        source: String,
        byte_from: usize,
        byte_to: usize,
        from: usize,
        to: usize,
        normalized_changed: bool,
    }

    #[derive(serde::Deserialize)]
    struct KhmerCompletionFixture {
        name: String,
        input: String,
        cursor: usize,
        from: usize,
        to: usize,
        first: String,
    }

    fn source_slice_utf16(text: &str, from: usize, to: usize) -> String {
        let map = utf16_to_byte_boundaries(text);
        let range = utf16_byte_range(&map, from, to, text.len()).expect("valid fixture range");
        text[range].to_string()
    }

    #[test]
    fn khmer_reference_provider_fixtures_are_locked() {
        const PINNED_UPSTREAM: &str = "cb7f972843d60bfec767f38802ecb89c40c1c49f";
        let fixture: KhmerReferenceFixture =
            serde_json::from_str(include_str!("../../../tests/fixtures/khmer/provider.json"))
                .expect("Khmer provider reference fixture");
        assert_eq!(fixture.fixture_version, 1);
        assert_eq!(fixture.upstream_commit, PINNED_UPSTREAM);

        let provider = KhmerProvider::new().expect("Khmer provider");
        for example in fixture.segmentation {
            let analysis = provider
                .analyze(&example.input)
                .unwrap_or_else(|error| panic!("{}: {error}", example.name));
            let actual: Vec<KhmerTokenFixture> = analysis
                .tokens
                .iter()
                .filter(|token| {
                    token
                        .text
                        .chars()
                        .any(|character| ('\u{1780}'..='\u{17d3}').contains(&character))
                })
                .map(|token| KhmerTokenFixture {
                    normalized: token.text.clone(),
                    source: source_slice_utf16(&example.input, token.from, token.to),
                    from: token.from,
                    to: token.to,
                    known: token.known,
                    known_prefix: example
                        .tokens
                        .iter()
                        .find(|expected| expected.from == token.from && expected.to == token.to)
                        .and_then(|expected| expected.known_prefix)
                        .map(|_| token.known_prefix),
                })
                .collect();
            assert_eq!(actual, example.tokens, "{}", example.name);
        }

        for example in fixture.normalization {
            let upstream = provider
                .segmenter
                .segment_detailed(&example.input)
                .unwrap_or_else(|error| panic!("{} upstream: {error}", example.name));
            let mapped = upstream
                .mapped_segments()
                .iter()
                .find(|segment| {
                    &upstream.normalized()[segment.normalized_range.clone()]
                        == example.normalized.as_str()
                })
                .unwrap_or_else(|| panic!("{}: upstream mapped segment not found", example.name));
            assert_eq!(
                mapped.source_range.start, example.byte_from,
                "{}",
                example.name
            );
            assert_eq!(mapped.source_range.end, example.byte_to, "{}", example.name);

            let analysis = provider
                .analyze(&example.input)
                .unwrap_or_else(|error| panic!("{}: {error}", example.name));
            assert_eq!(
                analysis.normalized_changed, example.normalized_changed,
                "{}",
                example.name
            );
            let token = analysis
                .tokens
                .iter()
                .find(|token| token.from == example.from && token.to == example.to)
                .unwrap_or_else(|| panic!("{}: mapped token not found", example.name));
            assert_eq!(token.text, example.normalized, "{}", example.name);
            assert_eq!(
                source_slice_utf16(&example.input, token.from, token.to),
                example.source,
                "{}",
                example.name
            );
        }

        for example in fixture.completion {
            let response = complete_with_provider(
                &provider,
                &CompletionRequest {
                    provider: provider.id().to_string(),
                    text: example.input,
                    cursor_utf16: example.cursor,
                    limit: 10,
                },
            )
            .unwrap_or_else(|error| panic!("{}: {error}", example.name))
            .unwrap_or_else(|| panic!("{}: completion missing", example.name));
            assert_eq!(response.from, example.from, "{}", example.name);
            assert_eq!(response.to, example.to, "{}", example.name);
            assert_eq!(
                response.options.first().map(String::as_str),
                Some(example.first.as_str()),
                "{}",
                example.name
            );
        }
    }

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
            if provider.is_known_word(prefix) {
                assert_eq!(response.options.first().map(String::as_str), Some(prefix));
            } else {
                assert!(!response.options.iter().any(|option| option == prefix));
            }
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
        assert_eq!(response.options.first().map(String::as_str), Some("សាលា"));
        assert!(response.options.iter().any(|option| option == "សាលារៀន"));
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
    fn includes_the_current_known_word_as_a_completion_option() {
        let provider = KhmerProvider::new().unwrap();
        let word = "ការងារ";
        assert!(provider.is_known_word(word));
        let response = complete_with_provider(
            &provider,
            &CompletionRequest {
                provider: "khmer-segmenter".to_string(),
                text: word.into(),
                cursor_utf16: word.encode_utf16().count(),
                limit: 10,
            },
        )
        .unwrap()
        .expect("known word completion");
        assert_eq!(response.from, 0);
        assert_eq!(response.to, word.encode_utf16().count());
        assert_eq!(response.options.first().map(String::as_str), Some(word));
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

    struct GreekMockProvider;
    impl LanguageSegmenter for GreekMockProvider {
        fn id(&self) -> &'static str {
            "mock-greek"
        }
        fn display_name(&self) -> &'static str {
            "Mock Greek"
        }
        fn language_tag(&self) -> &'static str {
            "el"
        }
        fn scripts(&self) -> &[&str] {
            &["Grek"]
        }
        fn support_level(&self) -> &'static str {
            "enhanced"
        }
        fn boundary_quality(&self) -> &'static str {
            "tested"
        }
        fn pattern(&self) -> &'static str {
            "[\u{0370}-\u{03ff}]+"
        }
        fn supports(&self, text: &str) -> bool {
            text.chars()
                .any(|character| ('\u{0370}'..='\u{03ff}').contains(&character))
        }
        fn analyze(&self, text: &str) -> Result<TextAnalysis, String> {
            let mut tokens = Vec::new();
            let mut start = None::<usize>;
            let mut utf16 = 0;
            for character in text.chars() {
                let is_greek = ('\u{0370}'..='\u{03ff}').contains(&character);
                match (start, is_greek) {
                    (None, true) => start = Some(utf16),
                    (Some(from), false) => {
                        tokens.push(SegmentToken {
                            text: "mock-greek-word".to_string(),
                            from,
                            to: utf16,
                            known: false,
                            known_prefix: false,
                            hyphenated: None,
                        });
                        start = None;
                    }
                    _ => {}
                }
                utf16 += character.len_utf16();
            }
            if let Some(from) = start {
                tokens.push(SegmentToken {
                    text: "mock-greek-word".to_string(),
                    from,
                    to: utf16,
                    known: false,
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
            Vec::new()
        }
    }

    struct FailingProvider;
    impl LanguageSegmenter for FailingProvider {
        fn id(&self) -> &'static str {
            "mock-failing"
        }
        fn pattern(&self) -> &'static str {
            "[A-Za-z]+"
        }
        fn supports(&self, text: &str) -> bool {
            text.chars()
                .any(|character| character.is_ascii_alphabetic())
        }
        fn analyze(&self, _text: &str) -> Result<TextAnalysis, String> {
            Err("intentional provider failure".to_string())
        }
        fn suggestions(&self, _word: &str, _limit: usize) -> Vec<String> {
            Vec::new()
        }
    }

    #[test]
    fn test_khmer_hyphenation_lookup() {
        let provider = KhmerProvider::new().unwrap();
        let analysis = provider.analyze("សាលារៀន").unwrap();
        assert!(!analysis.tokens.is_empty());

        let words_with_hyphens: Vec<_> = analysis
            .tokens
            .iter()
            .filter(|t| t.hyphenated.is_some())
            .collect();

        // Let's assert that at least one token has hyphenated representation
        assert!(
            !words_with_hyphens.is_empty(),
            "No hyphenated tokens found! Words analyzed: {:?}",
            analysis.tokens
        );
    }

    #[test]
    fn merges_tokens_from_multiple_providers() {
        use crate::segmentation::provider::AnalyzeRequest;

        let registry = SegmentationRegistry {
            providers: Arc::new(RwLock::new(vec![
                Arc::new(KhmerProvider::new().unwrap()),
                Arc::new(MockProvider),
            ])),
        };

        let response = registry
            .analyze_ranges(AnalyzeRequest {
                chunks: vec![crate::segmentation::provider::AnalyzeChunk {
                    text: "សាលារៀន hello invalidword".to_string(),
                    start_utf16: 0,
                }],
            })
            .expect("analyze language ranges");

        assert!(!response.tokens.is_empty());
        let khmer_tokens: Vec<_> = response
            .tokens
            .iter()
            .filter(|t| t.provider == "khmer-segmenter")
            .collect();
        let mock_tokens: Vec<_> = response
            .tokens
            .iter()
            .filter(|t| t.provider == "mock-provider")
            .collect();

        assert!(!khmer_tokens.is_empty());
        assert!(!mock_tokens.is_empty());

        assert!(khmer_tokens
            .iter()
            .any(|t| t.source_text == "សាលារៀន" && t.known));
        assert!(mock_tokens
            .iter()
            .any(|t| t.source_text == "hello" && t.known));
        assert!(mock_tokens
            .iter()
            .any(|t| t.source_text == "invalidword" && !t.known));
    }

    #[test]
    fn merges_mixed_scripts_with_exact_utf16_ranges_and_isolates_failures() {
        let registry = SegmentationRegistry {
            providers: Arc::new(RwLock::new(vec![
                Arc::new(KhmerProvider::new().unwrap()),
                Arc::new(EnglishHunspellProvider::new().unwrap()),
                Arc::new(GreekMockProvider),
                Arc::new(FailingProvider),
            ])),
        };
        let text = "😀 សាលារៀន hello κόσμος";
        let response = registry
            .analyze_ranges(AnalyzeRequest {
                chunks: vec![crate::segmentation::provider::AnalyzeChunk {
                    text: text.to_string(),
                    start_utf16: 7,
                }],
            })
            .expect("mixed analysis");

        for (provider, source) in [
            ("khmer-segmenter", "សាលារៀន"),
            ("hunspell:en_US", "hello"),
            ("mock-greek", "κόσμος"),
        ] {
            let token = response
                .tokens
                .iter()
                .find(|token| token.provider == provider && token.source_text == source)
                .unwrap_or_else(|| panic!("missing {provider} token for {source}"));
            let byte_from = text.find(source).expect("source range");
            let expected_from = 7 + text[..byte_from].encode_utf16().count();
            assert_eq!(token.source_from_utf16, expected_from);
            assert_eq!(
                token.source_to_utf16,
                expected_from + source.encode_utf16().count()
            );
        }
        assert!(response.failures.iter().any(|failure| {
            failure.provider == "mock-failing"
                && failure.message == "intentional provider failure"
                && failure.source_from_utf16 == 7
        }));
        assert!(response
            .tokens
            .iter()
            .any(|token| token.provider == "hunspell:en_US"));
    }

    #[test]
    fn english_hunspell_provider_checks_and_suggests_words() {
        let provider = EnglishHunspellProvider::new().expect("English provider");
        let analysis = provider
            .analyze("This sentence has a recieve typo.")
            .expect("analysis");
        assert!(analysis
            .tokens
            .iter()
            .any(|token| token.text == "sentence" && token.known));
        assert!(analysis
            .tokens
            .iter()
            .any(|token| token.text == "recieve" && !token.known));
        let suggestions = provider.suggestions("recieve", 8);
        assert!(suggestions.iter().any(|word| word == "receive"));
    }

    #[test]
    fn english_hunspell_provider_completes_prefixes() {
        let provider = EnglishHunspellProvider::new().expect("English provider");
        let response = complete_with_provider(
            &provider,
            &CompletionRequest {
                provider: "hunspell:en_US".to_string(),
                text: "I went to schoo".to_string(),
                cursor_utf16: "I went to schoo".encode_utf16().count(),
                limit: 10,
            },
        )
        .expect("completion")
        .expect("completion response");
        assert_eq!(response.from, "I went to ".encode_utf16().count());
        assert_eq!(response.to, "I went to schoo".encode_utf16().count());
        assert!(response.options.iter().any(|word| word == "school"));
    }

    #[test]
    fn registry_bundles_english_by_default() {
        let registry = SegmentationRegistry::new().expect("registry");
        assert!(registry
            .provider_snapshot()
            .expect("provider snapshot")
            .iter()
            .any(|provider| provider.id() == "hunspell:en_US"));
        let response = registry
            .analyze_ranges(AnalyzeRequest {
                chunks: vec![crate::segmentation::provider::AnalyzeChunk {
                    text: "hello wrld".to_string(),
                    start_utf16: 0,
                }],
            })
            .expect("analysis");
        assert!(response
            .tokens
            .iter()
            .any(|token| token.provider == "hunspell:en_US"
                && token.source_text == "wrld"
                && !token.known));
    }

    #[test]
    fn reports_support_depth_stability_and_independent_capabilities() {
        let registry = SegmentationRegistry::new().expect("registry");
        let capabilities = registry.provider_capabilities().expect("capabilities");
        let khmer = capabilities
            .iter()
            .find(|provider| provider.id == "khmer-segmenter")
            .expect("Khmer capabilities");
        assert_eq!(khmer.support_level, "deep");
        assert_eq!(khmer.stability, "experimental");
        assert!(khmer.supports_spellcheck);
        assert!(khmer.supports_completion);
        assert!(khmer.has_editing_policy);
        assert!(!khmer.supports_corrections);
        let serialized = serde_json::to_value(khmer).expect("serialized capabilities");
        assert_eq!(
            serialized["schemaVersion"],
            PROVIDER_CAPABILITY_SCHEMA_VERSION
        );
        assert_eq!(serialized["scripts"][0], "Khmr");
        assert_eq!(serialized["boundaryQuality"], "dedicated");
        assert!(serialized.get("schema_version").is_none());

        let english = capabilities
            .iter()
            .find(|provider| provider.id == "hunspell:en_US")
            .expect("English capabilities");
        assert_eq!(english.support_level, "enhanced");
        assert_eq!(english.stability, "stable");
        assert!(english.supports_spellcheck);
        assert!(english.supports_completion);
        assert!(!english.has_editing_policy);

        let fallback = catalog_entry(None, &HUNSPELL_CATALOG[0]);
        assert_eq!(fallback.support_level, "basic");
        assert_eq!(fallback.stability, "stable");
        assert!(fallback.supports_spellcheck);
        assert!(fallback.supports_corrections);
        assert!(!fallback.supports_completion);
        assert!(!fallback.has_editing_policy);
    }

    #[test]
    fn registry_analyzes_typst_content_only_for_english() {
        let registry = SegmentationRegistry::new().expect("registry");
        let source = r#"#import "chapters/intro-file.typ": template
#include "stories/rabbit-story.typ"
#let previewRoot = true
#set text(font: "Fira Mono")

This paragraph has a recieve typo.
#figure(image("assets/photo-file.png"))[The captin text is checked.]
"#;
        let response = registry
            .analyze_ranges(AnalyzeRequest {
                chunks: vec![crate::segmentation::provider::AnalyzeChunk {
                    text: source.to_string(),
                    start_utf16: 0,
                }],
            })
            .expect("analysis");
        let english_tokens: Vec<_> = response
            .tokens
            .iter()
            .filter(|token| token.provider == "hunspell:en_US")
            .collect();

        assert!(english_tokens
            .iter()
            .any(|token| token.source_text == "recieve" && !token.known));
        assert!(english_tokens
            .iter()
            .any(|token| token.source_text == "captin" && !token.known));
        for skipped in [
            "import",
            "chapters",
            "intro",
            "file",
            "typ",
            "include",
            "rabbit",
            "story",
            "previewRoot",
            "true",
            "Fira",
            "Mono",
            "assets",
            "photo",
        ] {
            assert!(
                !english_tokens
                    .iter()
                    .any(|token| token.source_text == skipped),
                "{skipped} should not be spellchecked"
            );
        }
    }
}
