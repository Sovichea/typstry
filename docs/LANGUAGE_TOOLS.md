# Language Tools Providers

Typstry's editor spellcheck, correction suggestions, and typing word suggestions are routed through a provider registry in `src-tauri/src/segmentation/registry.rs`.

Language support uses the Basic, Enhanced, and Deep taxonomy defined in [Product Direction and Terminology](./PRODUCT_DIRECTION.md). Stability is reported separately as Stable or Experimental. The frontend must display only the capabilities explicitly advertised by each provider.

Unknown words can be handled from the editor context menu in two distinct ways. **Add to dictionary** treats the word as correct and removes it from spellcheck. **Ignore** keeps the word visible with a blue informational underline and keeps it in the Spellcheck log for navigation, but excludes it from problem counters. Both word lists persist in application settings; **Stop ignoring** restores the normal unknown-word warning.

The frontend remains provider-neutral:

- CodeMirror asks Rust for provider capabilities.
- Incremental editor ranges are sent to `analyze_language_ranges`.
- Right-click correction menus call `language_suggestions` with the provider ID stored on the issue. Corrections never open automatically while typing.
- Providers advertise whether correction menus are reliable. Khmer corrections are currently disabled because deterministic segmentation can expose only an unknown fragment inside the intended word; the implementation remains available for a future reliable word-span strategy.
- Visible unknown-word issues are published to the log console with exact editor offsets. The Spellcheck tab shows their live count, and selecting an entry centers the corresponding source range. The All, LSP, Spellcheck, and Dev tabs keep language issues separate from compiler and developer output.
- Typing suggestions call `complete_language_word` with the active provider ID.
- Replacements are still guarded by document key, revision, document identity, and source text.

## Bundled providers

### Khmer

Provider ID: `khmer-segmenter`

Support: **Deep · Experimental**

Khmer uses the pinned `third_party/khmer_segmenter` implementation for normalization-preserving segmentation, dictionary checks, correction ranking, and completion. See [Khmer Spellcheck and Word Completion](./KHMER_SPELLCHECK.md).

### English (US)

Provider ID: `hunspell:en_US`

Support: **Enhanced · Stable**

English is bundled by default under `src-tauri/resources/dictionaries/hunspell/en_US/`.

The dictionary files are Hunspell-format `en_US.aff` and `en_US.dic` from the LibreOffice dictionaries repository, derived from SCOWL. License/source details are retained in `README_en_US.txt` and summarized in `metadata.json`.

Typstry uses the pure-Rust `spellbook` engine to read Hunspell-compatible dictionaries. This avoids requiring a system Hunspell installation or shipping platform-specific native Hunspell libraries.

English support uses:

- Spellcheck and correction suggestions from `spellbook`.
- A Typstry-built prefix index from `.dic` stems for typing word suggestions.
- Conservative editor token filtering to avoid marking obvious Typst commands, identifiers, URLs, email fragments, acronyms, and one-letter fragments.

## Downloadable Hunspell-compatible languages

Typstry can install additional Hunspell-compatible dictionaries from the Settings **Add language...** catalog. Downloaded dictionaries are stored in app-local data under:

```text
<app-local-data>/dictionaries/hunspell/<locale>/
  <locale>.aff
  <locale>.dic
```

The starter catalog uses verified raw dictionary paths from the LibreOffice dictionaries repository and intentionally includes Unicode/complex-script languages such as Arabic, Bengali, Tibetan, Gujarati, Hebrew, Hindi, Lao, Marathi, Nepali, Punjabi, Sinhala, Tamil, Telugu, Thai, and Vietnamese, plus common Latin-script dictionaries.

The provider registry instantiates one provider per installed language ID, e.g. `hunspell:fr_FR`, and refreshes provider capabilities after installation without requiring an app restart.

Downloaded Hunspell-compatible dictionaries are registered as **Basic · Stable**. They advertise spellcheck and corrections, but not typing word completion or reliable language segmentation. A future tested tokenizer-backed provider can supersede that fallback and advertise additional capabilities.

For languages with reliable whitespace or Unicode word boundaries, a Hunspell-compatible provider can provide useful Basic spellcheck and correction support quickly.

For languages that require segmentation, such as Thai, the Hunspell-compatible provider should be treated as a basic fallback:

- Use dictionary-derived segmentation/tokenization when no custom segmenter exists.
- Mark provider capabilities with a lower boundary quality when that metadata is surfaced.
- Let a future custom provider replace the fallback without changing the editor contract.

Provider-specific language logic belongs in Rust providers. Generic frontend controllers should not hardcode language-specific script regexes or dictionary behavior.
