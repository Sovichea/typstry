use serde::{Deserialize, Serialize};

pub const PROVIDER_CAPABILITY_SCHEMA_VERSION: u32 = 1;

/// Returns `Ok(())` if `license` is a non-empty, non-`"unknown"` string.
/// Used by the registry to reject providers that have not declared a redistributable
/// license for their dictionary or segmentation data.
pub fn validate_license(provider_id: &str, license: &str) -> Result<(), String> {
    let trimmed = license.trim();
    if trimmed.is_empty() || trimmed == "unknown" {
        return Err(format!(
            "Provider '{}' has an invalid license '{}'. \
             Set license() to a valid SPDX expression or attribution string.",
            provider_id, license
        ));
    }
    Ok(())
}

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
    pub failures: Vec<ProviderFailure>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderFailure {
    pub provider: String,
    pub operation: String,
    pub source_from_utf16: usize,
    pub source_to_utf16: usize,
    pub message: String,
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
    pub schema_version: u32,
    pub id: String,
    pub pattern: String,
    pub display_name: String,
    pub language_tag: String,
    pub scripts: Vec<String>,
    pub engine: String,
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
    pub provider_type: String,
    pub version: String,
    pub license: String,
}

pub trait LanguageSegmenter: Send + Sync {
    fn id(&self) -> &'static str;
    fn display_name(&self) -> &'static str {
        self.id()
    }
    fn language_tag(&self) -> &'static str {
        "und"
    }
    fn scripts(&self) -> &[&str] {
        &[]
    }
    fn engine(&self) -> &'static str {
        "custom"
    }
    fn support_level(&self) -> &'static str {
        "basic"
    }
    fn stability(&self) -> &'static str {
        "stable"
    }
    fn boundary_mode(&self) -> &'static str {
        "custom"
    }
    fn boundary_quality(&self) -> &'static str {
        "general"
    }
    fn provider_type(&self) -> &'static str {
        "dictionary-only"
    }
    fn version(&self) -> &'static str {
        "1.0.0"
    }
    /// SPDX license expression or attribution string for the dictionary / segmentation data.
    /// MUST NOT return `"unknown"` or an empty string — the registry rejects providers that do.
    fn license(&self) -> &'static str {
        "unknown"
    }
    fn supports_spellcheck(&self) -> bool {
        true
    }
    fn supports_corrections(&self) -> bool {
        true
    }
    fn correction_quality(&self) -> &'static str {
        if self.supports_corrections() {
            "dictionary"
        } else {
            "none"
        }
    }
    fn supports_completion(&self) -> bool {
        false
    }
    fn supports_segmentation(&self) -> bool {
        false
    }
    fn supports_custom_dictionary(&self) -> bool {
        true
    }
    fn has_editing_policy(&self) -> bool {
        false
    }
    fn pattern(&self) -> &'static str;
    fn supports(&self, text: &str) -> bool;
    fn analyze(&self, text: &str) -> Result<TextAnalysis, String>;
    fn suggestions(&self, word: &str, limit: usize) -> Vec<String>;
    fn is_known_word(&self, _word: &str) -> bool {
        false
    }
    fn autocomplete(&self, _prefix: &str, _limit: usize) -> Vec<String> {
        Vec::new()
    }
}
