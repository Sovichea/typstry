# Lao language support

Lao is Typstry's second complex-script portability implementation. It validates that a language can add tokenizer-backed language tools without modifying the Khmer editing policy, Khmer provider, or generic CodeMirror controllers.

## Support level

| Capability | Status |
|---|---|
| Unicode-safe editor navigation | Unicode baseline |
| Script-specific editing policy | Not registered |
| Word tokenization | ICU4X compiled dictionary model |
| Spellcheck and corrections | Optional LibreOffice `lo_LA` Hunspell dictionary |
| Word completion | Experimental; available after installing `lo_LA` |
| Custom dictionary | Supported by the generic language-tools layer |
| Stability | Experimental enhanced support |

Typstry intentionally does not claim deep or stable Lao linguistic support. A fluent Lao maintainer or reviewer has not yet signed off on the fixtures and completion quality. The implementation is suitable for portability testing and opt-in use, not as an assertion that every compound or domain-specific term is segmented correctly.

## Sources and licensing

- Word boundaries use [ICU4X `WordSegmenter` 2.2 compiled data](https://docs.rs/icu_segmenter/2.2.0/icu_segmenter/struct.WordSegmenter.html). ICU supports complex-script word segmentation for Lao and publishes its data under the Unicode license.
- Spellcheck uses [LibreOffice Dictionaries `lo_LA`](https://github.com/LibreOffice/dictionaries/tree/master/lo_LA), version `2019.10.01`, licensed under GPL-3.0. Typstry downloads it only when the user adds Lao in Language Tools; it is not bundled.
- Editor fixtures are locked to [Unicode Standard Annex #29](https://www.unicode.org/reports/tr29/) behavior and include canonical, malformed, mixed-script, and non-BMP cases.

## Architecture

The downloaded `hunspell:lo_LA` provider is upgraded from the generic dictionary-only path to a `dictionary-plus-tokenizer` provider:

```text
Typst markup range
→ ICU4X Lao word boundaries
→ original byte boundaries converted to UTF-16 once
→ Hunspell known/unknown lookup
→ explicit token and completion replacement ranges
```

No Lao regular expression is added to `appController.ts`, CodeMirror extensions, spellcheck, or autocomplete. Script detection remains provider metadata returned by Rust.

## Editing-policy decision

Lao uses Typstry's Unicode grapheme and code-point fallback. The locked fixtures cover tone marks, following vowels, malformed isolated marks, selection boundaries, deletion, Latin neighbors, and emoji neighbors. They do not demonstrate a source-corrupting behavior that justifies a Lao-specific policy.

This is deliberate: a script policy should be registered only when real fixtures prove the Unicode baseline inadequate. Khmer tailoring remains exclusively owned by the Khmer policy.

## Known limits

- ICU and Hunspell may disagree about compounds or specialized vocabulary.
- Hunspell correction quality depends on the upstream dictionary and is not context-sensitive.
- Completion is dictionary-prefix based after ICU tokenization; it is not a language model.
- One-character tokens may be accepted when ICU identifies them as a word, but dictionary coverage still determines known/unknown state.
- The provider must remain experimental until reviewed by fluent Lao contributors on Windows and Linux.

## Contributor validation

Run:

```bash
bun test tests/laoReference.test.ts tests/khmerReference.test.ts tests/editingPolicies.test.ts
cargo test --lib lao_
```

Then install Lao from Settings → Language Tools and test unspaced Lao prose, mixed Khmer/Lao text, completion replacement ranges, corrections, and removal of the provider. Removing Lao must restore Unicode-only behavior without modifying source documents or Khmer results.
