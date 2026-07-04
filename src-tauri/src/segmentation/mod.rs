mod provider;
mod registry;

pub use registry::{
    analyze_language_ranges, complete_language_word, get_provider_capabilities,
    language_suggestions, SegmentationRegistry,
};
