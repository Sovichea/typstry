# Product Direction and Terminology

This document is the source of truth for Typstella's public positioning, feature names, and language-support labels. README text, Settings labels, release notes, repository metadata, and contributor documentation should follow it.

## Positioning

### Product description

Typstella is a complex-script-first writing environment for Typst, designed for research papers, technical documentation, theses, books, and other long-form documents.

It serves writers and researchers whose languages are not always well supported by traditional technical-writing tools. Typstella focuses on Unicode-safe editing, script-aware interaction, reliable PDF preview, extensible language tools, and scalable multi-file project workflows while keeping Typst source portable.

Khmer is the first language with deep support. It demonstrates the depth Typstella aims to provide; it is not the boundary of the project.

### One-line pitch

> A complex-script-first Typst environment for research and long-form multilingual writing.

### Short description

> Serious Typst authoring for complex scripts, with deep Khmer support.

### GitHub repository description

> A complex-script-first Typst environment for research, technical documentation, and long-form multilingual writing.

The GitHub description must be updated manually in repository settings when this wording changes.

## Feature taxonomy

### Script-aware editing

Synchronous editor behavior that controls navigation, selection, deletion, composition boundaries, and editor-only decorations for a Unicode script. It does not depend on a dictionary or native language request.

### Language tools

Provider-backed spelling analysis, correction suggestions, dictionaries, tokenization or segmentation, and typing word completion. Each capability is advertised independently.

### Document workflow

Project identity, main and standalone documents, templates, chapters, includes, imports, bibliographies, figures, preview, navigation, workspace restoration, and export.

Do not use **language tools** as a synonym for script-aware editing. Do not describe dictionary installation as adding script-aware editor behavior.

## Language-support levels

Support depth and provider stability are separate. An experimental provider can still implement deep support, and a stable dictionary can still provide only basic support.

### Basic

Dictionary-backed spelling support using general text boundaries.

Requirements:

- identifies a locale and script;
- performs bounded dictionary lookup;
- reports exact UTF-16 source ranges for the boundaries it recognizes;
- declares whether corrections are available;
- does not imply reliable segmentation or word completion.

Typical example: a downloaded Hunspell-compatible dictionary.

### Enhanced

Tested language-aware behavior beyond general dictionary lookup.

Requirements:

- meets all Basic requirements;
- adds a tested tokenizer, reliable word boundaries, word completion, or another provider-specific capability;
- advertises only capabilities covered by fixtures;
- documents remaining boundary limitations.

Current example: bundled English support with tested completion and general Unicode word boundaries.

### Deep

Dedicated language tooling combined with any required script-aware editing behavior.

Requirements:

- meets all applicable Enhanced requirements;
- uses a dedicated tokenizer or segmenter when the language requires one;
- preserves exact source ranges through normalization;
- provides tested mixed-script, malformed-input, and completion behavior;
- supplies a script editing policy when Unicode grapheme behavior alone is insufficient;
- remains isolated from other languages' policies and providers.

Current example: Khmer, using the Khmer editing policy and Khmer segmenter.

## Stability labels

### Stable

The advertised capabilities pass the maintained fixture set and are enabled in normal builds.

### Experimental

The implementation is usable but has documented limitations or still requires broader validation. The UI must display the Experimental label independently from Basic, Enhanced, or Deep.

Khmer language support is currently **Deep · Experimental** because it has dedicated editing and segmentation, while correction spans and some lexical boundaries still have documented limitations.

## Independent capabilities

The following are separate and must not be inferred from one another:

- script-aware editing;
- spellcheck;
- correction suggestions;
- typing word completion;
- tokenization or segmentation;
- custom dictionary support.

Examples:

- Disabling spellcheck must not disable Khmer cursor and deletion behavior.
- Disabling typing suggestions must not disable spelling analysis.
- Installing a Hunspell dictionary must not imply the presence of a script editing policy.
- A provider with unreliable correction spans may support spellcheck and completion while disabling corrections.

## Wording rules

- Use **complex-script-first**, not “Unicode-friendly,” as the project-level direction.
- Use **Khmer is the first deeply supported language**, not “Khmer-only.”
- Use **script-aware editing** for navigation and deletion behavior.
- Use **spellcheck** for unknown-word analysis.
- Use **typing word suggestions** or **word completion** for interactive dictionary completion.
- Use **installed languages** in user-facing Settings; reserve **provider** for technical documentation and developer diagnostics.
- Never call a dictionary download “full language support.”
- Never list a capability unless the provider advertises it.
- Label experimental features explicitly.

## Surfaces to keep aligned

When the positioning or taxonomy changes, review:

- README and release notes;
- GitHub repository description;
- Settings and onboarding;
- language catalog and installed-language rows;
- About content if an About dialog is added;
- documentation and contributor templates.
