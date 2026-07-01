use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SegmentToken {
    pub text: String,
    pub from: usize,
    pub to: usize,
    pub known: bool,
    pub known_prefix: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextAnalysis {
    pub provider: &'static str,
    pub normalized_changed: bool,
    pub tokens: Vec<SegmentToken>,
}

pub trait LanguageSegmenter: Send + Sync {
    fn id(&self) -> &'static str;
    fn supports(&self, text: &str) -> bool;
    fn analyze(&self, text: &str) -> Result<TextAnalysis, String>;
    fn suggestions(&self, word: &str, limit: usize) -> Vec<String>;
    fn render_replacements(&self, text: &str) -> Vec<RenderReplacement>;
}

#[derive(Clone, Debug)]
pub struct RenderReplacement {
    pub source: String,
    pub segmented: String,
    pub hyphenated: String,
}
