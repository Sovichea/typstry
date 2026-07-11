// PROVIDER TEMPLATE — Copy this file to src-tauri/src/segmentation/<script_name>_provider.rs
// and edit every TODO comment before registering your provider.
//
// This file implements the LanguageSegmenter trait for a new language/script.
// The trait is defined in src-tauri/src/segmentation/provider.rs.
//
// REQUIRED methods (no defaults in the trait):
//   id()       — unique provider ID string (e.g. "lo_LA")
//   pattern()  — regex pattern matching text this provider handles
//   supports() — returns true if this provider can analyze the given text
//   analyze()  — segment text into tokens with known/unknown status
//   suggestions() — return spelling correction candidates for an unknown word
//
// All other trait methods have defaults you may override to report capabilities.
//
// LICENSE REQUIREMENT (P9.6):
//   license() MUST NOT return "unknown". Every provider must declare a valid
//   SPDX license expression or attribution string. The registry rejects providers
//   with unknown or empty licenses at registration time.
//
// REGISTRATION:
//   After implementing, register in SegmentationRegistry::new() inside registry.rs:
//
//     fn new(app_data_dir: PathBuf) -> Self {
//         let mut registry = Self { ... };
//         registry.register_provider(Arc::new(TemplateProvider::new()));
//         registry
//     }
//
//   Only register stable providers in new(). Experimental providers should be
//   gated behind a settings flag until acceptance criteria are met.

use super::provider::{LanguageSegmenter, SegmentToken, TextAnalysis};

// ---------------------------------------------------------------------------
// Provider struct
// ---------------------------------------------------------------------------

pub struct TemplateProvider {
    // TODO: Add your provider's internal state here.
    // Examples:
    //   - A Hunspell dictionary handle
    //   - An ICU word segmenter
    //   - A custom word list / trie
    //
    // The struct must be Send + Sync (required by the trait bound).
    // Use Arc<RwLock<...>> if you need shared mutable state.
}

impl TemplateProvider {
    pub fn new() -> Self {
        // TODO: Initialize your provider here.
        // Load dictionary files, build indices, or set up segmenter state.
        //
        // Use include_bytes! or include_str! for files bundled at compile time:
        //   const DICT_DATA: &[u8] = include_bytes!("../../../resources/dictionaries/...");
        //
        // Use runtime file paths (from app_data_dir) for downloaded dictionaries.
        Self {}
    }
}

// ---------------------------------------------------------------------------
// LanguageSegmenter implementation
// ---------------------------------------------------------------------------

impl LanguageSegmenter for TemplateProvider {
    // -----------------------------------------------------------------------
    // Identity and metadata
    // -----------------------------------------------------------------------

    fn id(&self) -> &'static str {
        // TODO: Replace with your provider's unique ID.
        // Convention: BCP 47 language tag or "engine:locale" (e.g. "lo_LA", "hunspell:th").
        // This ID is stored in user settings and must remain stable across versions.
        "template-provider"
    }

    fn display_name(&self) -> &'static str {
        // TODO: Human-readable name shown in the Settings language panel.
        "Template Language"
    }

    fn language_tag(&self) -> &'static str {
        // TODO: BCP 47 language tag (e.g. "lo", "lo-LA", "th", "ar").
        "und" // "und" = undetermined — replace this
    }

    fn scripts(&self) -> &[&str] {
        // TODO: ISO 15924 script codes this provider handles.
        // These are used for UI display and capability routing, not ownership enforcement.
        // (Ownership enforcement applies only to editing policies, not providers.)
        &["Zzzz"] // Replace with real script code(s)
    }

    fn engine(&self) -> &'static str {
        // TODO: Segmentation engine name. Examples: "hunspell", "icu4x", "khmer-segmenter", "custom".
        "custom"
    }

    fn support_level(&self) -> &'static str {
        // TODO: One of "basic", "enhanced", or "deep".
        //   "basic"    — Hunspell-compatible dictionary only; no reliable tokenization.
        //   "enhanced" — custom tokenizer or boundary logic added.
        //   "deep"     — full editing policy + segmentation + spellcheck + completion.
        //
        // Do NOT claim "deep" unless an editing policy is registered AND all acceptance
        // criteria in docs/COMPATIBILITY_POLICY.md are met.
        "basic"
    }

    fn stability(&self) -> &'static str {
        // TODO: "stable" or "experimental".
        // Use "experimental" until promotion criteria in docs/COMPATIBILITY_POLICY.md are met.
        "experimental"
    }

    fn version(&self) -> &'static str {
        // TODO: Semantic version of the dictionary or segmentation data (not the provider code).
        // Example: "2024.01.15" (data release date) or "2.1.0".
        "0.0.0"
    }

    fn license(&self) -> &'static str {
        // TODO: SPDX license expression for the dictionary and segmentation data.
        // Examples: "GPL-2.0-or-later", "MIT", "MPL-2.0", "GPL-2.0 OR LGPL-2.1 OR MPL-1.1"
        //
        // MUST NOT be "unknown" or empty — the registry will reject your provider.
        // If your data has a custom license, use a short attribution string and
        // document the full terms in docs/LANGUAGE_CONTRIBUTOR_GUIDE.md.
        "unknown" // TODO: Replace before registering!
    }

    fn boundary_mode(&self) -> &'static str {
        // TODO: "unicode" | "dictionary" | "icu" | "custom"
        "unicode"
    }

    fn boundary_quality(&self) -> &'static str {
        // TODO: "general" | "fallback" | "dedicated"
        //   "fallback"  — unicode grapheme fallback; may not respect script clusters
        //   "general"   — reasonable for most words
        //   "dedicated" — language-specific segmenter with documented precision
        "fallback"
    }

    fn supports_spellcheck(&self) -> bool {
        // TODO: Return true if analyze() can return known/unknown status.
        true
    }

    fn supports_corrections(&self) -> bool {
        // TODO: Return true if suggestions() returns useful correction candidates.
        true
    }

    fn supports_completion(&self) -> bool {
        // TODO: Return true if autocomplete() returns prefix-based candidates.
        false
    }

    fn supports_segmentation(&self) -> bool {
        // TODO: Return true if this provider performs sub-grapheme boundary splitting.
        false
    }

    fn has_editing_policy(&self) -> bool {
        // TODO: Return true if a ScriptEditingPolicy is registered for this script.
        // This is a metadata flag only — the policy is registered separately in the
        // TypeScript registry.
        false
    }

    fn pattern(&self) -> &'static str {
        // TODO: A regex pattern matching the text this provider handles.
        // The registry uses this to route document ranges to the correct provider.
        //
        // Example for Lao (U+0E80–U+0EFF):
        //   "[\\u0E80-\\u0EFF][\\u0E80-\\u0EFF'\\u200B-]*"
        //
        // Keep the pattern tight: only match text this provider can actually analyze.
        // Overlapping patterns between providers causes ambiguous routing.
        "[REPLACE_WITH_SCRIPT_UNICODE_RANGE]+"
    }

    // -----------------------------------------------------------------------
    // Core segmentation methods
    // -----------------------------------------------------------------------

    fn supports(&self, text: &str) -> bool {
        // TODO: Return true if this provider can analyze `text`.
        // Usually: check whether `text` contains any code points from your script range.
        //
        // Example for Lao:
        //   text.chars().any(|c| ('\u{0E80}'..'\u{0F00}').contains(&c))
        //
        // This is called frequently; keep it O(1) or O(n) with early return.
        let _ = text;
        false
    }

    fn analyze(&self, text: &str) -> Result<TextAnalysis, String> {
        // TODO: Segment `text` into tokens and determine known/unknown status.
        //
        // Return a TextAnalysis containing:
        //   - provider: self.id() (for error attribution)
        //   - normalized_changed: true if your normalizer changed the text
        //   - tokens: Vec<SegmentToken> with from/to byte offsets in the ORIGINAL text
        //
        // IMPORTANT byte-offset invariants:
        //   - from/to are byte offsets into `text` (UTF-8), NOT UTF-16 or char indices.
        //   - Tokens must be non-overlapping and sorted by `from`.
        //   - from and to must fall on valid UTF-8 character boundaries.
        //   - from must be <= to; empty tokens (from == to) are allowed only for
        //     zero-width markers (ZWSP, ZWNJ). Do not emit them for normal words.
        //
        // If analysis fails unrecoverably, return Err(message). The registry will
        // record a ProviderFailure and continue with other providers.

        let _ = text;

        // TODO: Replace with real segmentation logic.
        Ok(TextAnalysis {
            provider: self.id(),
            normalized_changed: false,
            tokens: vec![
                SegmentToken {
                    text: text.to_string(),
                    from: 0,
                    to: text.len(),
                    known: false,       // TODO: look up in dictionary
                    known_prefix: false, // TODO: check if any known word starts with this
                    hyphenated: None,
                },
            ],
        })
    }

    fn suggestions(&self, word: &str, limit: usize) -> Vec<String> {
        // TODO: Return up to `limit` correction candidates for `word`.
        //
        // CONTRACT:
        //   - Return at most `limit` items (enforced by the registry, but be polite).
        //   - Do NOT perform a full dictionary scan on every call (performance gate: p95 < 50ms).
        //   - Return an empty Vec if corrections are not supported or the word has no candidates.
        //   - Candidates should be sorted by edit distance or confidence (best first).

        let _ = (word, limit);
        vec![]
    }

    fn is_known_word(&self, word: &str) -> bool {
        // TODO: Return true if `word` is in your dictionary.
        // Used for fast known/unknown classification without full analysis.
        let _ = word;
        false
    }

    fn autocomplete(&self, prefix: &str, limit: usize) -> Vec<String> {
        // TODO: Return up to `limit` words that start with `prefix`.
        // Only implement if supports_completion() returns true.
        // Performance gate: p95 < 50ms.
        let _ = (prefix, limit);
        vec![]
    }
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------
//
// Run with: cargo test --lib segmentation::template_provider
//
// Every provider MUST include tests for:
//   1. Known words are classified correctly
//   2. Unknown words are classified correctly
//   3. Byte offsets match UTF-8 boundaries (not UTF-16 or char indices)
//   4. Mixed-script text routes correctly (script text vs. Latin punctuation)
//   5. Non-BMP characters (emoji, supplementary scripts) don't panic
//   6. suggestions() returns at most `limit` candidates
//   7. autocomplete() returns at most `limit` candidates (if supported)

#[cfg(test)]
mod tests {
    use super::*;

    fn provider() -> TemplateProvider {
        TemplateProvider::new()
    }

    #[test]
    fn supports_returns_false_for_latin_text() {
        // TODO: Replace "hello" with a Latin string your provider should reject.
        assert!(!provider().supports("hello"));
    }

    #[test]
    fn analyze_does_not_panic_on_empty_string() {
        let result = provider().analyze("");
        assert!(result.is_ok());
        assert!(result.unwrap().tokens.is_empty());
    }

    #[test]
    fn analyze_does_not_panic_on_non_bmp_text() {
        // Non-BMP: 𐐷 (U+10437, Deseret) — two UTF-16 code units, four UTF-8 bytes
        let result = provider().analyze("𐐷");
        assert!(result.is_ok());
    }

    #[test]
    fn suggestions_respects_limit() {
        let suggestions = provider().suggestions("test", 3);
        assert!(suggestions.len() <= 3);
    }

    #[test]
    fn byte_offsets_are_valid_utf8_boundaries() {
        let text = "test"; // TODO: Replace with a real script example
        if let Ok(analysis) = provider().analyze(text) {
            for token in &analysis.tokens {
                // Check that byte offsets fall on valid UTF-8 char boundaries
                assert!(text.is_char_boundary(token.from));
                assert!(text.is_char_boundary(token.to));
                assert!(token.from <= token.to);
            }
        }
    }
}
