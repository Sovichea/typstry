use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SegmentToken {
    pub text: String,
    pub from: usize,
    pub to: usize,
    pub known: bool,
    pub known_prefix: bool,
    pub hyphenated: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextAnalysis {
    pub provider: &'static str,
    pub normalized_changed: bool,
    pub tokens: Vec<SegmentToken>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyzeChunk {
    pub text: String,
    pub start_utf16: usize,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyzeRequest {
    pub chunks: Vec<AnalyzeChunk>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorToken {
    pub provider: String,
    pub source_from_utf16: usize,
    pub source_to_utf16: usize,
    pub source_text: String,
    pub normalized_text: String,
    pub known: bool,
    pub known_prefix: bool,
    pub hyphenated: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyzeResponse {
    pub tokens: Vec<EditorToken>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletionRequest {
    pub provider: String,
    pub text: String,
    pub cursor_utf16: usize,
    pub limit: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletionResponse {
    pub provider: String,
    pub from: usize,
    pub to: usize,
    pub options: Vec<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SuggestionRequest {
    pub provider: String,
    pub word: String,
    pub limit: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SuggestionResponse {
    pub suggestions: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCapabilities {
    pub id: String,
    pub pattern: String,
}

pub trait LanguageSegmenter: Send + Sync {
    fn id(&self) -> &'static str;
    fn pattern(&self) -> &'static str;
    fn supports(&self, text: &str) -> bool;
    fn analyze(&self, text: &str) -> Result<TextAnalysis, String>;
    fn suggestions(&self, word: &str, limit: usize) -> Vec<String>;
    fn autocomplete(&self, _prefix: &str, _limit: usize) -> Vec<String> {
        Vec::new()
    }
}
