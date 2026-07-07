mod provider;
mod registry;

pub use provider::ProviderCapabilities;
pub use registry::{
    analyze_language_ranges, complete_language_word, get_provider_capabilities,
    install_hunspell_dictionary, language_suggestions, list_hunspell_catalog, SegmentationRegistry,
};
