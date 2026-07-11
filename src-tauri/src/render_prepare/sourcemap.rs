use serde::{Deserialize, Serialize};

pub const SOURCE_MAP_VERSION: u32 = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MappingKind {
    Original,
    InsertedZws,
    GeneratedWrapper,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TextMapping {
    pub generated_start: usize,
    pub generated_end: usize,
    pub source_start: usize,
    pub source_end: usize,
    pub kind: MappingKind,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceMap {
    pub version: u32,
    pub source_file: String,
    pub generated_file: String,
    pub mappings: Vec<TextMapping>,
}

impl SourceMap {
    pub fn new(source_file: String, generated_file: String) -> Self {
        Self {
            version: SOURCE_MAP_VERSION,
            source_file,
            generated_file,
            mappings: Vec::new(),
        }
    }

    pub fn add_mapping(
        &mut self,
        generated_start: usize,
        generated_end: usize,
        source_start: usize,
        source_end: usize,
        kind: MappingKind,
    ) {
        self.mappings.push(TextMapping {
            generated_start,
            generated_end,
            source_start,
            source_end,
            kind,
        });
    }

    pub fn generated_to_source(&self, generated_offset: usize) -> Option<usize> {
        let idx = self.mappings.binary_search_by(|m| {
            if generated_offset < m.generated_start {
                std::cmp::Ordering::Greater
            } else if generated_offset >= m.generated_end {
                std::cmp::Ordering::Less
            } else {
                std::cmp::Ordering::Equal
            }
        });
        match idx {
            Ok(i) => {
                let m = &self.mappings[i];
                match m.kind {
                    MappingKind::Original => {
                        let offset_in_mapping = generated_offset - m.generated_start;
                        Some(m.source_start + offset_in_mapping)
                    }
                    MappingKind::InsertedZws => Some(m.source_start),
                    MappingKind::GeneratedWrapper => Some(m.source_start),
                }
            }
            Err(_) => {
                if self.mappings.is_empty() {
                    return None;
                }
                if generated_offset >= self.mappings.last().unwrap().generated_end {
                    return Some(self.mappings.last().unwrap().source_end);
                }
                if generated_offset <= self.mappings.first().unwrap().generated_start {
                    return Some(self.mappings.first().unwrap().source_start);
                }
                let insert_idx = self
                    .mappings
                    .partition_point(|m| m.generated_start <= generated_offset);
                if insert_idx > 0 {
                    let prev = &self.mappings[insert_idx - 1];
                    Some(prev.source_end)
                } else {
                    None
                }
            }
        }
    }

    pub fn source_to_generated(&self, source_offset: usize) -> Option<usize> {
        for m in &self.mappings {
            if m.kind == MappingKind::Original
                && source_offset >= m.source_start
                && source_offset < m.source_end
            {
                let offset_in_mapping = source_offset - m.source_start;
                return Some(m.generated_start + offset_in_mapping);
            }
        }
        for m in &self.mappings {
            if source_offset == m.source_start {
                return Some(m.generated_start);
            }
        }
        if let Some(last) = self.mappings.last() {
            if source_offset >= last.source_end {
                return Some(last.generated_end);
            }
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sourcemap_lookups() {
        let mut map = SourceMap::new("src.typ".into(), "dest.typ".into());

        // Mappings representing "ក\u{200b}ខ"
        // Original "ក" at source 0..3 (length 3), gen 0..3
        map.add_mapping(0, 3, 0, 3, MappingKind::Original);
        // Inserted ZWS at gen 3..6, source 3..3
        map.add_mapping(3, 6, 3, 3, MappingKind::InsertedZws);
        // Original "ខ" at source 3..6 (length 3), gen 6..9
        map.add_mapping(6, 9, 3, 6, MappingKind::Original);

        // generated_to_source lookups:
        // Inside "ក": e.g. gen 1 -> source 1
        assert_eq!(map.generated_to_source(1), Some(1));
        // Inside ZWS: e.g. gen 4 -> source 3 (end of previous word)
        assert_eq!(map.generated_to_source(4), Some(3));
        // Inside "ខ": e.g. gen 7 -> source 4
        assert_eq!(map.generated_to_source(7), Some(4));

        // source_to_generated lookups:
        // Inside "ក": e.g. source 1 -> gen 1
        assert_eq!(map.source_to_generated(1), Some(1));
        // Inside "ខ": e.g. source 4 -> gen 7
        assert_eq!(map.source_to_generated(4), Some(7));
        // End boundary: e.g. source 6 -> gen 9
        assert_eq!(map.source_to_generated(6), Some(9));
    }
}
