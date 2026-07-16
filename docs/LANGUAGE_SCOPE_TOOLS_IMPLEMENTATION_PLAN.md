# Typst Language-Scope Tools Implementation Plan

## Objective

Make deterministic language tools follow explicit Typst language scopes while keeping typing suggestions responsive to the user's active keyboard or input method.

- Spellcheck follows statically resolvable `text` language and region changes, including direct `text(...)` calls and `set text(...)` rules. The `script` field is tracked for fidelity but remains a shaping concern rather than a dictionary-language selector.
- Word completion follows the active keyboard/input-source language after IME composition has committed.
- A scope whose primary spellcheck provider is not installed produces no spelling diagnostics for that language's scripts; configured embedded languages in other scripts may still be checked.
- The corresponding static `lang: "xx"` declaration receives a hint decoration, tooltip, and warning gutter marker.
- Accepted terminology can apply globally, to one workspace, or to one language family without leaking ordinary words into unrelated languages.
- Script editing policies, text direction, spellcheck, and word completion remain independent capabilities.

This work extends the existing provider-neutral `SpellcheckController`, `createTypstAutocomplete`, capability registry, revision checks, and IME protections. It must not introduce language-specific logic into generic CodeMirror integration.

## Typst Semantic Baseline

Implementation and fixtures must track the official Typst semantics documented in:

- [`text.lang`, `text.region`, and `text.script`](https://typst.app/docs/reference/text/text/);
- [set-rule, set-if, and show-set behavior](https://typst.app/docs/reference/styling/);
- [code blocks, content blocks, functions, conditionals, loops, and includes](https://typst.app/docs/reference/scripting/);
- [contextual styling limitations](https://typst.app/docs/reference/context/).

If the managed Typst toolchain changes these semantics, update fixtures and the parser compatibility matrix before changing editor routing.

## Product Rules

### Spellcheck authority

Resolve spellcheck in this order:

1. The nearest statically resolvable direct `text(...)` language-style override.
2. The nearest active, preceding unconditional `set text(...)` rule in the current code or content scope.
3. Typst's root defaults (`lang: "en"`, `region: none`, `script: auto`) for the main file when no override applies.
4. Existing provider-by-script routing only where the effective context is genuinely unknown, such as unresolved dynamic styling or inherited include call-site context.

Typst stores these fields independently: `lang` is a case-insensitive ISO 639-1/2/3 code, `region` is a case-insensitive ISO 3166-1 alpha-2 code or `none`, and `script` is `auto` or an OpenType writing-script identifier commonly based on ISO 15924. Do not parse a Typst `lang` string such as `en-US` as a BCP-47 locale. Combine language and region only when resolving an installed provider locale. Do not reinterpret `text.script` as a different natural language: Typst documents it as an OpenType shaping control.

An explicit language scope is authoritative for the scripts used by that language. Typsastra must not silently substitute another provider that uses the same script, because script identity is not language identity. It may still check clearly different-script runs through configured embedded-language providers.

### Mixed-script scopes

Typst permits one `lang` value at a time, but natural prose often embeds English or another language without wrapping every word in a nested `#text` call. Typsastra therefore uses a primary-plus-embedded model:

- the effective Typst `lang` and `region` select the primary language provider, while provider metadata and actual Unicode text runs determine script ownership;
- configured embedded-language providers may analyze runs in disjoint scripts;
- only one provider may own a given script in a scope;
- providers sharing a script with the primary language are not used implicitly;
- nested explicit `#text(lang: "yy")` remains the way to switch between languages that share a script.

For example, in `#text(lang: "km")[...]`, Khmer-script runs use the Khmer provider while embedded Latin-script words may use the configured English provider. In `#text(lang: "fr")[...]`, Typsastra must not use an English provider for unmarked Latin text because both languages use the Latin script.

Add an ordered **Embedded spellcheck languages** setting initialized from enabled providers, preserving today's bundled Khmer/English mixed-script behavior. The primary language is removed from the embedded set for its scope. Ordering matters only when multiple enabled languages advertise the same foreign script: use the first provider and expose that choice in Settings rather than running conflicting dictionaries. Installing a provider must not silently add it to an explicitly customized embedded list.

### Accepted terms and personal dictionaries

Do not make every user-added word language-specific or every accepted ordinary word global. Support three explicit acceptance scopes:

1. **Project terminology** accepts names, brands, acronyms, identifiers, and research terms across every language provider in the current workspace.
2. **Global terminology** accepts the same kind of term across every workspace and language provider.
3. **Language dictionary** accepts an ordinary word only for a canonical ISO 639 language family resolved from provider locale tags, such as `en` for `en-US` and `en-GB` but not `fr`.

The spelling context menu should use an `Add “word” to…` submenu containing the applicable project terminology, global terminology, and the issue-producing provider's language-family dictionary action. This ensures an English issue embedded in Khmer is added to English, not Khmer. Keep `Ignore…` separate and scope it explicitly: language, project, or global. New ignore actions must not default to a silent global suppression. Do not silently infer acceptance scope from capitalization or script.

For example, `Typsastra` belongs in global or project terminology and must remain accepted inside English, French, Khmer, or Lao scopes. An uncommon English word belongs in the English dictionary and must still be eligible for a French spelling warning.

Matching rules:

- store the original Unicode term rather than a provider-generated normalized key;
- normalize safely at comparison time without changing source ranges;
- terminology entries preserve case by default, so accepting `Typsastra` does not automatically accept `typsastra`;
- language-dictionary entries use the target provider's comparison rules within the selected language family;
- a provider ID or dictionary implementation version must not be the persistence key;
- changing a term invalidates only affected spelling results and never alters completion dictionaries automatically.

Persist global terminology, global ignores, and language dictionaries/ignores in the application `settings.json`. Persist project terminology and project ignores in the workspace's `.typsastra` settings so they follow project export/import. Migrate existing global `editor.userDictionary` entries to global terminology and existing `editor.ignoredWords` entries to explicit legacy-global ignores with compatibility match modes that preserve current behavior.

Store project terminology in `.typsastra/config.json`, not the ephemeral `.typsastra/workspace.json`, so copied and exported projects retain it. Bump and migrate both settings schemas explicitly. Bound term count and term length, deduplicate normalized entries, reject control characters, and render imported terms with text-only DOM APIs.

The first release accepts one provider token at a time, including provider-recognized hyphenated tokens. Multiword terminology requires a separate phrase-matching design and is out of scope.

### Completion authority

Typing-word completion is independent from spellcheck scope:

1. A temporary user-selected completion-language override, when present.
2. The active OS keyboard/input-source language.
3. The effective Typst language scope when input-source detection is unavailable.
4. Existing provider-by-script behavior as the compatibility fallback.

The current token must be compatible with the selected provider's advertised script/pattern. If it is incompatible, suppress language completion instead of silently routing to an unrelated provider. Typst/Tinymist source completion remains available.

### IME ownership

From `compositionstart` until the committed `compositionend` transaction:

- do not open Typsastra word completion;
- do not replace or segment partial composition text;
- do not publish transient spelling issues;
- allow the operating-system IME to own its candidate interface.

After commit, refresh the relevant spellcheck range. Offer Typsastra completion only when a useful incomplete token remains.

### Missing-provider presentation

For a static language declaration without an enabled, installed spellcheck provider:

- do not analyze or underline runs belonging to the unavailable primary language;
- continue checking configured embedded languages only when their scripts are known and disjoint from the primary language's scripts;
- apply a subtle hint decoration to the complete `lang: "xx"` argument;
- show a tooltip such as `Spellcheck for Khmer (km) is not installed for this scope.`;
- show one warning symbol in the gutter on the physical line containing the affected `lang` argument, even when a multiline `set text(...)` begins on an earlier line;
- offer `Install language tools` only when the language exists in the downloadable catalog;
- remove the hint and marker immediately after a successful install or provider enablement.

This state is language-tool guidance. It must not increase Typst/LSP compilation error or warning counts. Multiple unavailable declarations on one line share one gutter marker and list all affected languages in its tooltip.

Do not publish missing-language hints until installed capabilities and the downloadable catalog have finished their initial load. Suppress all of these hints and gutter markers when global spellcheck is disabled. An intentionally disabled installed provider receives a neutral informational hint at most, not a warning gutter marker. Invalid Typst syntax or an invalid language/region value remains owned by Tinymist diagnostics and must not receive a duplicate language-tools warning.

Distinguish these cases:

| Declaration | Behavior |
| --- | --- |
| Installed and enabled provider | Route primary-script runs to that provider and eligible foreign-script runs to configured embedded providers. |
| Installed but disabled provider | Skip its script runs; optionally show a neutral enable hint without a warning gutter marker. Eligible disjoint embedded providers remain active. |
| Downloadable but not installed | Skip its script runs; tooltip offers installation. Use catalog script metadata to preserve eligible embedded checking. |
| Multiple equally valid regional providers | Skip ambiguous primary routing and offer a preferred-dictionary choice; never select by registry order. |
| Valid tag with no catalog/provider match | Disable scoped spellcheck because Typsastra cannot safely determine primary-script ownership; explain that no provider is available. |
| Invalid static language or region | Defer to Tinymist's diagnostic and do not add a duplicate language-tools gutter warning. |
| Dynamic expression such as `lang: language` | Mark the context unresolved internally; do not claim a language or show a missing-provider warning in the first release. |

## Supported Static Typst Forms

The first release supports direct static language-style values:

```typst
#text(lang: "km")[Khmer content]
#text("Bonjour", lang: "fr", region: "FR")
#set text(lang: "en", region: "GB")
English content

#block[
  #set text(lang: "lo")
  Lao content in a named block
]

#[
  #set text(lang: "km")
  Khmer content in an anonymous content block
]
```

Required semantics:

- `#text(lang: "xx")[...]` applies only to its content argument.
- A direct static string body such as `#text("Bonjour", lang: "fr")` is prose. Tokens crossing string escapes are skipped unless exact rendered-to-source mapping is available.
- `lang`, `region`, and `script` inherit and override independently. A rule that changes only `region` must retain the effective language.
- Root main-file defaults are `lang: "en"`, `region: none`, and `script: auto`.
- Nested `text` language arguments override their parent and restore it on exit.
- An unconditional `#set text(lang: "xx")` applies after the set rule through the remainder of the current lexical code or content block.
- Named content blocks such as `#block[...]` and anonymous content blocks written as `#[...]` both create nested lexical scopes.
- Content arguments on other function calls must receive the same delimiter-aware nesting behavior; `text` additionally supplies its explicit language override.
- Code blocks `{ ... }`, including function, conditional, and loop bodies, also bound set rules. A nested set rule restores the outer effective language when its code or content block closes.
- Multiple set rules in one scope take effect in source order.
- `set text(...) if condition` is applied only when the condition is statically `true`, ignored when statically `false`, and marks the following effective context unresolved for any other condition.
- A show-set rule such as `#show heading: set text(lang: "fr")` applies to selected output and must never be misread as a normal sequential set rule. Until Typsastra has selector-aware semantic data, a language-changing show rule makes potentially selected content unresolved and uses the documented compatibility fallback rather than pretending the surrounding language is exact.
- Comments, raw blocks, strings unrelated to the `lang` argument, code, math, URLs, labels, and references are not prose ranges.

Do not guess the runtime result of variables, argument spreading, aliases such as `text.with(...)`, nonliteral conditions, transformational show rules, contextual expressions, computed language values, or content constructed in one location and styled at another. The same content variable or included file can be inserted under multiple languages and has no single source-level runtime language. Detect statically visible shadowing/import replacement of the `text` identifier; an ambiguous `text(...)` or `set text(...)` must become unresolved rather than being assumed to reference Typst's built-in text element. Included files may receive styles from different call sites, so the first release applies explicit file-local scopes and treats unqualified inherited context as unresolved rather than inventing a single language.

## Target Architecture

Keep one editor-facing source of truth, backed by a syntax extractor that understands real Typst grammar:

```text
src/editor/languageScopes/
  client.ts          revision-safe native syntax extraction requests
  resolver.ts        nesting, set-rule propagation, and effective ranges
  providers.ts       Typst language-style to provider-locale resolution
  state.ts           revisioned CodeMirror state and update effects
  decorations.ts     declaration hints, tooltips, and gutter markers
  types.ts           shared scope and resolution contracts

src-tauri/src/language_scopes.rs
  pinned Typst-compatible syntax parsing, AST extraction, and byte-to-UTF-16 mapping
```

Core contracts:

```ts
type LanguageDeclaration = {
  kind: "text-call" | "set-rule";
  languageCode?: string;
  regionCode?: string | null;
  scriptCode?: string | "auto";
  argumentFrom: number;
  argumentTo: number;
  langArgumentFrom?: number;
  langArgumentTo?: number;
  diagnosticFrom: number;
  diagnosticTo: number;
  scopeFrom: number;
  scopeTo: number;
  confidence: "static" | "dynamic";
};

type EffectiveLanguageRange = {
  from: number;
  to: number;
  languageCode: string | null;
  regionCode: string | null;
  scriptCode: string | "auto";
  primaryProviderId: string | null;
  primaryScripts: string[];
  embeddedProviderIds: string[];
  confidence: {
    language: "static" | "dynamic";
    region: "static" | "dynamic";
    script: "static" | "dynamic";
  };
  resolution: "installed" | "disabled" | "missing" | "unsupported" | "ambiguous" | "invalid" | "dynamic";
  declaration: LanguageDeclaration | null;
};

type AcceptedTerm = {
  term: string;
  scope: "global" | "project" | "language";
  languageFamily?: string;
  matchMode: "exact-case" | "provider-normalized";
};

type IgnoredTerm = AcceptedTerm & {
  legacy?: boolean;
};
```

Ranges must be ordered, non-overlapping, UTF-16 CodeMirror offsets tied to `{ documentKey, revision, docIdentity, parserGeneration, providerGeneration }`. Adjacent ranges with identical effective style and resolution should be coalesced.

Do not derive scope nesting from regular expressions or the existing CodeMirror stream highlighter. It does not expose a structural Typst AST and cannot reliably distinguish ordinary set rules, set-if rules, show-set rules, function bodies, or malformed syntax.

Prefer the official `typst-syntax` parser, pinned and compatibility-tested against the managed Typst/Tinymist toolchain. Run extraction off the UI thread and convert parser byte ranges to CodeMirror UTF-16 offsets. Before committing to the dependency, record release binary-size, build-time, startup, and 100,000-character parse costs. A custom bounded scanner is permitted only if the parser dependency fails the documented budget and the scanner matches the official parser fixture corpus, including error recovery.

Track certainty independently for language, region, and script. A dynamic region may still permit a unique language-only provider, while an ambiguous regional choice remains unresolved. A dynamic script does not block language/region spellcheck resolution because it is not a dictionary selector. On incomplete or malformed edits, never retain a stale scope as if it were current. Publish conservative per-field dynamic/unresolved ranges until the syntax is valid, then re-resolve. Full syntax extraction may be debounced; spellcheck and UI results still require the current document revision.

## Provider Resolution

Add a provider index built from installed capabilities and the language catalog:

```text
effective Typst (ISO 639 lang, ISO 3166 region) + actual Unicode text script
  -> exact installed provider languageTag/locale match
  -> language + region + actual-script match
  -> language + actual-script match
  -> language-only match when unambiguous
  -> downloadable catalog entry
  -> unsupported
```

Requirements:

- Lowercase Typst language codes, uppercase region codes, and canonicalize provider/input-source BCP-47 tags separately while preserving source spelling in the editor.
- Resolve `lang: "en", region: "GB"` to `en-GB` before a generic English provider; never require users to write `lang: "en-GB"`.
- Maintain aliases for accepted ISO 639 two- and three-letter codes without conflating ISO 639-2 and ISO 639-3 where Typst export behavior differs.
- Treat `region: none` as unspecified rather than silently selecting an arbitrary regional dictionary when more than one is enabled.
- Never choose arbitrarily when multiple installed providers are equally valid.
- Add a persisted preferred dictionary locale per language family. Use it only when Typst leaves `region` unspecified and multiple enabled providers remain; if no preference exists, expose an ambiguous-language hint/action instead of selecting by registry order.
- Resolve the ordered embedded-language list to at most one provider per script.
- Exclude embedded providers whose scripts overlap the explicit primary language's scripts.
- Ignore `Common` and `Inherited` script classifications when deciding that two language providers are disjoint.
- Build text runs with Unicode Script Extensions and grapheme-safe boundaries. Attach combining marks to their base run; numbers, punctuation, emoji, `Common`, and `Inherited` characters do not independently select a dictionary.
- Do not route spellcheck through `text.script`; use provider metadata plus actual Unicode runs. Add a regression where `lang: "ro", script: "grek"` does not select a Greek-language dictionary.
- Provider install, removal, enablement, or capability changes invalidate the language map and spellcheck results.
- Resolve capabilities per feature: an installed provider without `supportsSpellcheck` still counts as unavailable for scoped spellcheck, while completion separately requires `supportsCompletion`. Never infer one capability from the other.
- Keep the capability schema provider-neutral; add fields only if existing `languageTag` and `scripts` cannot resolve an ambiguity.

## Spellcheck Pipeline Changes

Change `SpellcheckController.runAnalysis()` to intersect pending analysis ranges with the effective language map before invoking Rust.

Extend each native analysis chunk with optional routing:

```ts
type AnalyzeChunk = {
  text: string;
  startUtf16: number;
  providerIds?: string[];
  contentMode: "typst-source" | "plain-text";
};
```

- Installed explicit scope: submit its primary provider plus configured embedded providers whose scripts are disjoint.
- Missing or disabled explicit scope with known catalog scripts: omit the primary provider but submit eligible disjoint embedded providers.
- Unsupported or invalid explicit scope without trustworthy script metadata: submit no chunk.
- Explicitly unresolved dynamic or inherited area: omit `providerIds` and retain current provider-by-pattern compatibility routing. Main-file source without an override is not unresolved; it uses Typst's root defaults.

`typst-source` chunks retain the registry's current source scanner. `plain-text` chunks are already proven prose nodes, including supported direct `text("...")` bodies, and must not be discarded merely because they appear as string syntax. For strings containing escapes, map rendered characters back to exact source offsets or skip only tokens crossing an unmappable escape. Never return a replacement range covering quotes, commas, or escape syntax.

Update the Rust registry so a routed chunk invokes only the requested installed providers. Reject unknown provider IDs without falling back to every provider. Keep failures isolated per provider and preserve the existing revision-safe response handling.

Filter returned unknown tokens through accepted terms in this order:

1. exact project terminology;
2. exact global terminology;
3. language-family dictionary entries using the issue provider's language tag and normalization rules;
4. migrated compatibility entries.

Project/global terminology applies regardless of the active primary or embedded provider. Language entries apply only when the issue provider belongs to that canonical language family.

Apply scoped ignores after accepted-term lookup using the same issue-producing language family rules. Legacy migrated ignores remain explicitly global and manageable; new language/project/global ignores use their selected scope. Adding or ignoring a term must not automatically add it to word-completion candidates; completion dictionaries require their own licensing, ranking, and performance rules.

When a declaration or delimiter edit changes scope propagation, invalidate from the earliest affected declaration through the end of its lexical scope. Ordinary prose edits retain the current bounded incremental analysis behavior.

## Declaration Hints and Gutter Marker

Create a dedicated CodeMirror extension rather than merging these hints into Tinymist diagnostics:

- a `StateField` stores unresolved static declarations;
- `Decoration.mark` highlights `lang: "xx"` with a theme-aware hint class; for a region-only mutation that causes the unresolved locale, anchor the hint to `region: "XX"`;
- `hoverTooltip` explains resolution and exposes an install/enable action when applicable;
- `gutter()` renders a theme-aware warning marker on the line containing the affected argument;
- marker identity is stable across unrelated edits and mapped through transactions;
- tooltip actions revalidate document revision and provider state before acting.
- catalog loading, installation, removal, and provider enablement use explicit pending states so warnings do not flicker or briefly route through stale providers.

Accessibility requirements:

- the hint cannot rely on color alone;
- tooltip content is available through the declaration's title/ARIA description;
- gutter markers have an accessible label;
- installation remains available from Settings if a gutter cannot be operated with assistive technology.

## Keyboard/Input-Source Service

Add a platform-neutral frontend contract:

```ts
type InputSourceState = {
  languageTag: string | null;
  sourceId: string | null;
  displayName: string | null;
  generation: number;
  reliability: "native" | "manual" | "unavailable";
};
```

Platform adapters:

- **Windows:** resolve the active foreground thread keyboard layout to a BCP-47 locale and refresh on focus/key input or native layout-change notification.
- **macOS:** use the current text input source and its change notification. Ship only after native validation is available.
- **Linux:** support reliable XKB/IBus/Fcitx integrations where available; otherwise report `unavailable` and use the configured fallback.

Do not use `navigator.platform`, character guessing, or browser locale as proof of the active keyboard language. Do not poll continuously while the app is unfocused.

Custom layouts, remote-desktop layouts, and input sources without a stable locale report `unavailable` and fall back according to the selected completion mode. Input-source detection remains local and must not record typed text or transmit layout history.

Add settings:

- `Typing suggestions language: Follow keyboard | Follow Typst scope | Manual`;
- a manual language selector populated from providers supporting completion;
- a quick, non-distracting completion-language indicator/override near existing editor status controls;
- management lists for global terminology and per-language personal dictionaries;
- management lists for language, project, global, and migrated legacy-global ignores;
- preferred dictionary locale controls for language families with multiple installed regional providers;
- project terminology management from Workspace or Language Tools settings;
- a small status/tooltip describing the current completion source when detection is unavailable or no matching provider is installed.

## Completion Pipeline Changes

Replace the current loop over every completion-capable provider with one resolved provider:

```text
completion mode
  -> input-source/scope/manual language tag
  -> installed completion provider
  -> current token compatibility check
  -> complete_language_word(providerId, token range)
```

Requirements:

- preserve existing exact replacement ranges and Khmer unspaced-token behavior;
- require a syntax-proven prose context; never offer language words in Typst identifiers, `lang`/`region` values, ordinary strings, raw text, math, labels, references, URLs, or comments;
- suppress the language completion source while `EditorView.composing` is true;
- close or requery an open language-completion list when the input-source generation changes;
- suppress automatic language completion for multiple selections unless every caret has the same compatible language context and replacement shape;
- discard results when document revision, cursor, source text, input source, or provider generation changes;
- do not display an unavailable-provider editor warning for keyboard language, because it is not document source;
- keep explicit `Ctrl+Space` Typst/Tinymist completion working when language completion is unavailable;
- label language candidates with their provider/language when mixed with other completion sources.

## Implementation Phases

### Phase 0 — Syntax-parser and compatibility gate

- [x] Prototype extraction with the official `typst-syntax` parser.
- [x] Pin the parser version and test it against every supported managed Typst/Tinymist toolchain version.
- [x] Measure release binary size, clean build time, startup cost, and parse latency before accepting the dependency.
- [x] If the dependency exceeds the approved budget, document the threshold and require any fallback scanner to match the official parser fixture corpus and error recovery.
- [x] Define byte-to-UTF-16 conversion and malformed-edit behavior before editor integration.

Exit gate: one parser strategy is selected with measured costs and a version-compatibility policy; regex-only extraction is prohibited.

### Phase 1 — Contracts and fixtures

- [x] Define language declaration, effective range, provider resolution, and input-source contracts.
- [x] Define accepted-term persistence, matching, migration, and language-family contracts.
- [x] Add fixtures for inline calls, direct string bodies, unconditional set, set-if, show-set exclusions, shadowed/aliased `text`, spread arguments, named `#block[...]`, anonymous `#[...]`, code blocks, generic function content, nested, repeated, malformed, commented, raw, math, code, and mixed-script cases.
- [x] Lock independent inheritance of `lang`, `region`, and `script`, including Typst defaults and region-only changes.
- [x] Lock ISO 639 aliases, ISO 3166 regions, ambiguous provider locales, and invalid values owned by Tinymist.
- [x] Lock primary-plus-embedded behavior for Khmer/English, Lao/English, Arabic/English, and same-script French/English cases.
- [x] Verify that a French misspelling which is a valid English word remains an issue in a French scope.
- [x] Add UTF-16 fixtures containing emoji and non-BMP characters before declarations and scope boundaries.
- [x] Define the static/dynamic support boundary in user documentation.

Exit gate: expected effective ranges and declaration ranges are locked before editor integration.

### Phase 2 — Static scope parser and resolver

- [x] Implement revision-safe native syntax extraction and byte-to-UTF-16 mapping.
- [x] Implement code/content lexical propagation, independent style-field inheritance, and nested direct-call overrides.
- [x] Distinguish ordinary set, set-if, and show-set syntax without evaluating dynamic expressions.
- [x] Map supported direct string bodies conservatively across escapes.
- [x] Coalesce non-overlapping effective ranges.
- [x] Add debounced extraction and incremental spellcheck invalidation with a full-document correctness fallback.
- [x] Replace stale valid scopes with unresolved ranges during malformed/incomplete edits.
- [x] Benchmark 100,000-character and 1,000-declaration documents.

Exit gate: resolved ranges equal fresh full extraction for every fixture and randomized edit sequence, including error recovery.

### Phase 3 — Provider resolution and missing-language UI

- [ ] Build canonical installed/catalog provider indexes.
- [ ] Implement installed, disabled, downloadable, unsupported, invalid, and dynamic states.
- [ ] Add the ordered Embedded spellcheck languages setting and enforce one provider per foreign script.
- [ ] Gate resolution UI on provider/catalog readiness and global spellcheck enablement.
- [ ] Keep intentionally disabled-provider hints informational and avoid duplicating Tinymist diagnostics.
- [ ] Add theme-aware declaration hint decorations and tooltips.
- [ ] Add deduplicated gutter markers and accessible labels.
- [ ] Connect install/enable actions and remove resolved hints without reopening the file.

Exit gate: unavailable primary-script runs show no spelling squiggles, eligible embedded-language runs remain checked, and installing the provider activates only the intended primary runs.

### Phase 4 — Scope-routed spellcheck and accepted terms

- [ ] Split pending ranges by effective language range.
- [ ] Add optional provider routing to analysis chunks and Rust registry requests.
- [ ] Route primary and embedded providers by disjoint script ownership without same-script substitution.
- [ ] Add global terminology, project terminology, and language-family dictionary stores.
- [ ] Version and migrate application settings and `.typsastra/config.json` atomically.
- [ ] Migrate existing `editor.userDictionary` and `editor.ignoredWords` without changing legacy behavior; require explicit scope for new ignores.
- [ ] Validate imported project terminology bounds and render it as text only.
- [ ] Add the `Add to…` context submenu and terminology management UI.
- [ ] Apply exact-case terminology and provider-normalized language dictionary matching.
- [ ] Reanalyze only affected ranges after adding, editing, or removing a term.
- [ ] Preserve provider-by-script compatibility routing only for explicitly unresolved dynamic or inherited contexts.
- [ ] Invalidate propagated ranges when declarations change.
- [ ] Keep issue, suggestion, replacement, and provider-failure revision checks intact.

Exit gate: nested multilingual fixtures produce issues only from the primary or configured disjoint-script providers, never substitute a same-script language, and honor terminology without leaking language-specific words into other languages.

### Phase 5 — Keyboard-language completion

- [ ] Add the shared input-source service and settings schema.
- [ ] Implement and test the Windows adapter first.
- [ ] Handle custom/unmapped layouts, app focus changes, remote desktop, and layout changes while completion is open.
- [ ] Add scope and manual fallbacks.
- [ ] Resolve exactly one completion provider per request.
- [ ] Guard composition, cursor, provider, input-source, revision, and replacement ranges.
- [ ] Add macOS/Linux adapters behind reliability reporting and platform-specific validation.

Exit gate: changing keyboard language changes subsequent word suggestions without changing spellcheck scope or interrupting IME candidates.

### Phase 6 — Documentation, performance, and release gates

- [ ] Update Language Tools settings copy and multilingual examples.
- [ ] Update the bundled interactive language-tools example and multilingual template to demonstrate the completed behavior: English/Khmer/Arabic disjoint-script routing, explicit English/French/Spanish same-script scopes, nested `#text(...)`, named and anonymous set-rule blocks, missing-provider hint/gutter recovery, project/global versus language terminology, and keyboard-language completion without changing spellcheck scope.
- [ ] Add example README instructions that identify which providers must be installed, how to trigger each warning or completion state, and what should disappear after installing/enabling a provider; keep the default example usable when optional dictionaries are absent.
- [ ] Document static scope support and dynamic-expression limitations.
- [ ] Link behavior to the supported Typst language, region, script, set-rule, and content/code-block semantics.
- [ ] Add scope parse, provider resolution, and completion timing to performance diagnostics.
- [ ] Record parser dependency size/build impact and input-source adapter reliability by platform.
- [ ] Run Khmer, Lao, autocomplete, language-provider conformance, diagnostics, and long-document suites.
- [ ] Verify dark, light, and Typsastra themes plus keyboard-only and screen-reader behavior.

Exit gate: no regression in ordinary documents, Khmer completion, IME composition, or incremental spellcheck performance; main-file root routing matches Typst defaults.

## Required Regression Matrix

| Area | Required cases |
| --- | --- |
| Scope | Root defaults, independent lang/region/script inheritance, file-level set, code block, named `#block[...]`, anonymous `#[...]`, generic function content, inline text, direct string text, nested override, sequential set, set-if, show-set exclusion, malformed syntax. |
| Source exclusions | Comments, unrelated strings, URLs, labels, references, raw blocks, math, code expressions, dynamic/shadowed aliases, spread arguments, and tokens crossing unmappable string escapes. |
| Providers | Exact language/region, language fallback, ISO aliases, ambiguous locale, multiple scripts, disabled, removed, installed during session, catalog-not-ready, unsupported language, ordered embedded providers, same-script collision. |
| Accepted terms | Global and project terminology across providers, language-family isolation, scoped ignores, case preservation, single-token bounds, userDictionary/ignoredWords migration, removal, provider replacement, corrupt or oversized imported entries. |
| Unicode | Khmer, Lao, Arabic, combining marks, Script Extensions, emoji/non-BMP before and inside scopes, mixed normalization, Common/Inherited characters, mixed-script tokens. |
| Editing | Insert/delete declaration, change language/region/script, move delimiters, temporarily malformed syntax, undo/redo, paste, rapid typing, tab switch, provider install/uninstall during an in-flight request. |
| Completion | Keyboard/scope mismatch, direct layout, custom/unmapped layout, layout switch with popup open, IME composition, manual override, missing completion provider, multiple selections, stale response. |
| UI | Global spellcheck disabled, providers loading, intentionally disabled provider, multiple warnings per line, tooltip action, failed/cancelled install, theme contrast, gutter visibility, zoom, accessibility labels. |
| Projects | Main-file Typst defaults, included file opened independently, same file included in multiple contexts, main-file switch, restored tabs, copied workspace, project export/import. |
| Compatibility | Supported Typst/Tinymist versions, parser error recovery, settings schema migration, workspace config migration, older project archives. |

## Performance and Safety Gates

- Scope resolution must not block editor input or run native dictionary analysis on the UI thread.
- Syntax extraction must run off the UI thread, be cancellable by generation, and publish only for the current document identity and revision.
- An ordinary prose edit must not submit the full document for spellcheck.
- A declaration edit may invalidate its lexical scope but must remain bounded and revision-safe.
- Missing-primary-language scopes must skip that language's script runs while retaining only explicitly configured, disjoint-script embedded analysis.
- Accepted-term lookup must be bounded by indexed normalized keys and must not scan every stored term for each token.
- Stale scope, provider-install, input-source, spellcheck, and completion results must be discarded.
- No tooltip action may install or enable a provider based on stale document state without confirmation through the existing Language Tools workflow.
- Provider routing IDs received by Rust must be validated against the current registry snapshot; unknown or uninstalled IDs fail closed without falling back to all providers.
- Project terminology loaded from `.typsastra/config.json` must have count/length limits and must never be interpreted as HTML or executable Typst.

## Definition of Done

- A multilingual Typst file can use different installed spellcheck providers in nested static language scopes.
- Main-file root behavior matches Typst's `lang: "en"`, `region: none`, and `script: auto` defaults; unresolved include or dynamic contexts are labeled internally and never presented as certain.
- Language and region resolve independently, so `lang: "en", region: "GB"` can select an `en-GB` provider without accepting invalid `lang: "en-GB"` source.
- An unavailable explicit language receives no incorrect diagnostics for its scripts, while configured embedded languages in disjoint scripts may still be checked.
- Its `lang: "xx"` argument has a clear hint tooltip and warning gutter symbol.
- Installing or enabling the provider removes the warning and starts scoped analysis without reopening the workspace.
- `Typsastra` added to global or project terminology is accepted across language scopes, while a word added only to English remains checkable in French.
- Existing personal dictionary entries retain their behavior after settings migration.
- Existing persisted ignored words retain their behavior as visible legacy-global entries; new ignores require an explicit language, project, or global scope.
- Typing suggestions follow the configured keyboard/input-source language without changing document scope.
- IME candidate composition remains uninterrupted.
- Unscoped main documents follow Typst defaults while complex-script runs can still use configured disjoint embedded providers; unresolved contexts retain the documented compatibility fallback.
- All offsets remain correct in UTF-16 under complex scripts and non-BMP input.
- The implementation passes provider conformance, Khmer/Lao reference, autocomplete, diagnostics, accessibility, and performance gates.
