use super::sourcemap::{MappingKind, SourceMap};
use khmer_segmenter::kdict::KHypDict;
use khmer_segmenter::{KhmerSegmenter, SegmenterConfig};

const KHMER_DICTIONARY: &[u8] =
    include_bytes!("../../../third_party/khmer_segmenter/port/common/khmer_dictionary.kdict");
const KHMER_HYPHENATION: &[u8] =
    include_bytes!("../../../third_party/khmer_segmenter/port/common/khmer_hyphenation.kdict");
const MIN_LAYOUT_PART_CLUSTERS: usize = 2;

pub struct KhmerTextSegmenter {
    pub segmenter: KhmerSegmenter,
    pub hyphenation: KHypDict,
}

impl KhmerTextSegmenter {
    pub fn new() -> Result<Self, String> {
        let segmenter =
            KhmerSegmenter::from_bytes(KHMER_DICTIONARY.to_vec(), SegmenterConfig::default())
                .map_err(|error| format!("Failed to load Khmer dictionary: {}", error))?;
        let hyphenation = KHypDict::from_bytes(KHMER_HYPHENATION.to_vec())
            .map_err(|error| format!("Failed to load Khmer hyphenation dictionary: {}", error))?;
        Ok(Self {
            segmenter,
            hyphenation,
        })
    }
}

fn khmer_cluster_count(text: &str) -> usize {
    let mut clusters = 0;
    let mut has_current = false;
    let mut prev_is_coeng = false;

    for character in text.chars() {
        let is_base = ('\u{1780}'..='\u{17b3}').contains(&character);
        if is_base {
            if has_current && !prev_is_coeng {
                clusters += 1;
            }
            has_current = true;
        }
        prev_is_coeng = character == '\u{17d2}';
    }

    if has_current {
        clusters + 1
    } else {
        text.chars().count()
    }
}

fn layout_parts<'a>(
    source_text: &'a str,
    normalized_text: &str,
    hyphenation: &KHypDict,
) -> Vec<&'a str> {
    let Some(hyphenated) = hyphenation.lookup(normalized_text) else {
        return vec![source_text];
    };
    let hyphenation_parts: Vec<&str> = hyphenated
        .split('\u{200b}')
        .filter(|part| !part.is_empty())
        .collect();
    if hyphenation_parts.len() <= 1 {
        return vec![source_text];
    }
    if hyphenation_parts
        .iter()
        .any(|part| khmer_cluster_count(part) < MIN_LAYOUT_PART_CLUSTERS)
    {
        return vec![source_text];
    }

    let joined: String = hyphenation_parts.concat();
    if joined != source_text {
        return vec![source_text];
    }

    let mut parts = Vec::with_capacity(hyphenation_parts.len());
    let mut cursor = 0;
    for part in hyphenation_parts {
        let end = cursor + part.len();
        if !source_text.is_char_boundary(cursor) || !source_text.is_char_boundary(end) {
            return vec![source_text];
        }
        parts.push(&source_text[cursor..end]);
        cursor = end;
    }
    if cursor == source_text.len() {
        parts
    } else {
        vec![source_text]
    }
}

pub fn prepare_khmer_text_for_rendering(
    input: &str,
    segmenter: &KhmerSegmenter,
    hyphenation: &KHypDict,
    source_offset: usize,
    generated_offset_start: usize,
    sourcemap: &mut SourceMap,
    scope: super::scanner::ScopeState,
) -> String {
    let mut output = String::new();
    let mut current_gen_offset = generated_offset_start;

    let mut chars = input.char_indices().peekable();

    while let Some(&(start_idx, c)) = chars.peek() {
        let is_khmer = ('\u{1780}'..='\u{17ff}').contains(&c);
        let start_run = start_idx;
        let mut end_run = start_idx + c.len_utf8();
        chars.next();

        while let Some(&(next_idx, next_c)) = chars.peek() {
            let next_is_khmer = ('\u{1780}'..='\u{17ff}').contains(&next_c);
            if next_is_khmer == is_khmer {
                end_run = next_idx + next_c.len_utf8();
                chars.next();
            } else {
                break;
            }
        }

        let run_text = &input[start_run..end_run];
        let run_source_start = source_offset + start_run;
        let run_source_end = source_offset + end_run;

        if is_khmer && scope.par_justify && !scope.render_prep_disabled {
            if let Ok(segmentation) = segmenter.segment_detailed(run_text) {
                let segments = segmentation.mapped_segments();
                if segments.is_empty() {
                    let gen_len = run_text.len();
                    output.push_str(run_text);
                    sourcemap.add_mapping(
                        current_gen_offset,
                        current_gen_offset + gen_len,
                        run_source_start,
                        run_source_end,
                        MappingKind::Original,
                    );
                    current_gen_offset += gen_len;
                } else {
                    for (seg_idx, segment) in segments.iter().enumerate() {
                        let seg_source_range = &segment.source_range;
                        let normalized_text =
                            &segmentation.normalized()[segment.normalized_range.clone()];
                        let seg_text = &run_text[seg_source_range.clone()];
                        let seg_source_end = run_source_start + seg_source_range.end;
                        let layout_parts = layout_parts(seg_text, normalized_text, hyphenation);
                        let mut part_source_cursor = run_source_start + seg_source_range.start;

                        for (part_idx, part) in layout_parts.iter().enumerate() {
                            let part_len = part.len();
                            let part_source_start = part_source_cursor;
                            let part_source_end = part_source_start + part_len;

                            output.push_str(part);
                            sourcemap.add_mapping(
                                current_gen_offset,
                                current_gen_offset + part_len,
                                part_source_start,
                                part_source_end,
                                MappingKind::Original,
                            );
                            current_gen_offset += part_len;
                            part_source_cursor = part_source_end;

                            if part_idx + 1 < layout_parts.len() {
                                let boundary_char = "\u{200b}";
                                output.push_str(boundary_char);
                                let boundary_len = boundary_char.len();
                                sourcemap.add_mapping(
                                    current_gen_offset,
                                    current_gen_offset + boundary_len,
                                    part_source_end,
                                    part_source_end,
                                    MappingKind::InsertedZws,
                                );
                                current_gen_offset += boundary_len;
                            }
                        }

                        if seg_idx + 1 < segments.len() {
                            let boundary_char = "\u{200b}";
                            output.push_str(boundary_char);
                            let boundary_len = boundary_char.len();
                            sourcemap.add_mapping(
                                current_gen_offset,
                                current_gen_offset + boundary_len,
                                seg_source_end,
                                seg_source_end,
                                MappingKind::InsertedZws,
                            );
                            current_gen_offset += boundary_len;
                        }
                    }
                }
            } else {
                let gen_len = run_text.len();
                output.push_str(run_text);
                sourcemap.add_mapping(
                    current_gen_offset,
                    current_gen_offset + gen_len,
                    run_source_start,
                    run_source_end,
                    MappingKind::Original,
                );
                current_gen_offset += gen_len;
            }
        } else {
            let gen_len = run_text.len();
            output.push_str(run_text);
            sourcemap.add_mapping(
                current_gen_offset,
                current_gen_offset + gen_len,
                run_source_start,
                run_source_end,
                MappingKind::Original,
            );
            current_gen_offset += gen_len;
        }
    }

    output
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cooperation_word() -> &'static str {
        "\u{179f}\u{17a0}\u{1794}\u{17d2}\u{179a}\u{178f}\u{17b7}\
         \u{1794}\u{178f}\u{17d2}\u{178f}\u{17b7}\u{1780}\u{17b6}\u{179a}"
    }

    fn university_word() -> &'static str {
        "\u{179f}\u{17b6}\u{1780}\u{179b}\u{179c}\u{17b7}\u{1791}\u{17d2}\
         \u{1799}\u{17b6}\u{179b}\u{17d0}\u{1799}"
    }

    fn important_word() -> &'static str {
        "\u{179f}\u{17c6}\u{1781}\u{17b6}\u{1793}\u{17cb}"
    }

    fn cambodia_word() -> &'static str {
        "\u{1780}\u{1798}\u{17d2}\u{1796}\u{17bb}\u{1787}\u{17b6}"
    }

    fn remove_layout_controls(text: &str) -> String {
        text.replace('\u{200b}', "")
    }

    #[test]
    fn test_khmer_zws_insertion_uses_internal_layout_breaks() {
        let segmenter = KhmerTextSegmenter::new().unwrap();
        let source = cooperation_word();
        let mut map = SourceMap::new("src.typ".into(), "dest.typ".into());

        let scope = crate::render_prepare::scanner::ScopeState {
            par_justify: true,
            render_prep_disabled: false,
        };
        let output = prepare_khmer_text_for_rendering(
            source,
            &segmenter.segmenter,
            &segmenter.hyphenation,
            0,
            0,
            &mut map,
            scope,
        );

        assert_eq!(remove_layout_controls(&output), source);
        assert!(
            output.contains('\u{200b}'),
            "expected internal ZWSP layout breaks in {output:?}"
        );
        assert!(!map.mappings.is_empty());
    }

    #[test]
    fn test_khmer_hyphenation_inserts_internal_zws_breaks() {
        let segmenter = KhmerTextSegmenter::new().unwrap();
        let source = university_word();
        let mut map = SourceMap::new("src.typ".into(), "dest.typ".into());

        let scope = crate::render_prepare::scanner::ScopeState {
            par_justify: true,
            render_prep_disabled: false,
        };
        let output = prepare_khmer_text_for_rendering(
            source,
            &segmenter.segmenter,
            &segmenter.hyphenation,
            0,
            0,
            &mut map,
            scope,
        );

        assert!(
            output.contains('\u{200b}'),
            "expected internal ZWSP layout breaks from hyphenation data in {output:?}"
        );
        assert_eq!(remove_layout_controls(&output), source);
        assert!(!map.mappings.is_empty());
    }

    #[test]
    fn test_khmer_hyphenation_zws_rejects_too_short_parts() {
        let segmenter = KhmerTextSegmenter::new().unwrap();
        let mut map = SourceMap::new("src.typ".into(), "dest.typ".into());
        let scope = crate::render_prepare::scanner::ScopeState {
            par_justify: true,
            render_prep_disabled: false,
        };

        for source in [important_word(), cambodia_word()] {
            let output = prepare_khmer_text_for_rendering(
                source,
                &segmenter.segmenter,
                &segmenter.hyphenation,
                0,
                0,
                &mut map,
                scope,
            );
            assert_eq!(remove_layout_controls(&output), source);
        }
    }

    #[test]
    fn test_disable_render_prep_scope_leaves_khmer_text_unchanged() {
        let segmenter = KhmerTextSegmenter::new().unwrap();
        let source = cooperation_word();
        let mut map = SourceMap::new("src.typ".into(), "dest.typ".into());
        let scope = crate::render_prepare::scanner::ScopeState {
            par_justify: true,
            render_prep_disabled: true,
        };

        let output = prepare_khmer_text_for_rendering(
            source,
            &segmenter.segmenter,
            &segmenter.hyphenation,
            0,
            0,
            &mut map,
            scope,
        );

        assert_eq!(output, source);
        assert!(!output.contains('\u{200b}'));
    }
}
