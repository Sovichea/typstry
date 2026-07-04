use khmer_segmenter::{KhmerSegmenter, SegmenterConfig};
use super::sourcemap::{SourceMap, MappingKind};

const KHMER_DICTIONARY: &[u8] =
    include_bytes!("../../../third_party/khmer_segmenter/port/common/khmer_dictionary.kdict");

pub struct KhmerTextSegmenter {
    pub segmenter: KhmerSegmenter,
}

impl KhmerTextSegmenter {
    pub fn new() -> Result<Self, String> {
        let segmenter = KhmerSegmenter::from_bytes(KHMER_DICTIONARY.to_vec(), SegmenterConfig::default())
            .map_err(|error| format!("Failed to load Khmer dictionary: {}", error))?;
        Ok(Self { segmenter })
    }
}

pub fn prepare_khmer_text_for_rendering(
    input: &str,
    segmenter: &KhmerSegmenter,
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
        
        if is_khmer && scope.text_lang_km && scope.par_justify {
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
                        let seg_text = &run_text[seg_source_range.clone()];
                        let seg_len = seg_text.len();
                        
                        let seg_source_start = run_source_start + seg_source_range.start;
                        let seg_source_end = run_source_start + seg_source_range.end;
                        
                        output.push_str(seg_text);
                        sourcemap.add_mapping(
                            current_gen_offset,
                            current_gen_offset + seg_len,
                            seg_source_start,
                            seg_source_end,
                            MappingKind::Original,
                        );
                        current_gen_offset += seg_len;
                        
                        if seg_idx + 1 < segments.len() {
                            let boundary_char = if scope.text_hyphenate {
                                "\u{200b}\u{00ad}"
                            } else {
                                "\u{200b}"
                            };
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

    #[test]
    fn test_khmer_zws_insertion() {
        let segmenter = KhmerTextSegmenter::new().unwrap();
        let source = "Typstry គាំទ្រភាសាបារាំង";
        let mut map = SourceMap::new("src.typ".into(), "dest.typ".into());
        
        let scope = crate::render_prepare::scanner::ScopeState {
            text_lang_km: true,
            par_justify: true,
            text_hyphenate: false,
        };
        let output = prepare_khmer_text_for_rendering(
            source,
            &segmenter.segmenter,
            0,
            0,
            &mut map,
            scope,
        );
        
        let expected = "Typstry គាំទ្រ\u{200b}ភាសា\u{200b}បារាំង";
        assert_eq!(output, expected);
        assert!(!map.mappings.is_empty());
    }
}
