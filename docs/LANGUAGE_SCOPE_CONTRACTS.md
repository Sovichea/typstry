# Language Scope Contracts

This document freezes the Phase 1 contracts for scope-aware language tools. The native extractor and frontend resolver use contract version `1`.

## Source semantics

- A main Typst document starts with `lang: "en"`, `region: none`, and `script: auto`.
- Included source whose inherited document context is unknown starts with dynamic values. Typsastra does not invent a main-document default for an isolated include.
- `lang`, `region`, and `script` inherit and change independently. `script` affects shaping; it never selects a dictionary.
- Static strings are canonicalized only for lookup: ISO 639 language identifiers are lowercase, ISO 3166 region identifiers are uppercase, and script identifiers are lowercase. Tinymist remains responsible for diagnostics on invalid Typst values.
- Provider lookup may canonicalize registered ISO 639 aliases, but an ambiguous locale remains unresolved. It must not silently select the first provider.
- A static `region: none` is distinct from an absent region mutation and from a dynamic region expression.

Supported static declarations are direct builtin `text(...)` calls and ordinary `set text(...)` rules with statically written `lang`, `region`, or `script`. Literal `if true` is static, literal `if false` contributes no mutation, and other conditions are dynamic. Spread arguments, computed values, shadowed `text`, malformed syntax, and `show ...: set text(...)` are unresolved rather than evaluated.

Content blocks (`[...]`), anonymous content (`#[...]`), named `block[...]` content, and code blocks establish lexical propagation/restoration boundaries. Direct string bodies are supported only where exact source offsets exist; tokens crossing escapes are skipped. Comments, raw text, math, labels, references, URLs, ordinary code, and non-body strings are never exposed as prose.

## Script ownership

The primary language owns every script it actually supports. Embedded spellcheck providers may own only configured, disjoint foreign scripts. Script similarity is not permission to substitute a provider.

- English + Khmer + Arabic can route Latin, Khmer, and Arabic runs to their explicitly configured providers.
- French + English does not route a French-scope Latin word to English merely because English accepts it.
- English + French + Spanish therefore requires explicit `lang` scopes for same-script changes.
- A French misspelling that happens to be a valid English word remains a French issue.
- An explicit unresolved or unavailable language scope is not checked with a different same-script dictionary.

Provider availability is one of `installed`, `disabled`, `downloadable`, `unsupported`, `invalid`, or `dynamic`. Phase 2 records the language request; Phase 3 resolves that request against the provider catalog.

## Accepted terms

Accepted terms have three explicit persistence scopes:

- global terminology, shared across languages;
- project terminology, stored in `.typsastra/config.json` and exported with workspace settings;
- language-family dictionary, matched only for that canonical language family.

New records carry the term, scope, optional language family, and exact-case behavior. Existing `editor.userDictionary` and `editor.ignoredWords` retain their legacy matching during migration; migration must be versioned and atomic. A language-specific term never leaks into another family merely because both use the same script.

## Input language

Completion input language is independent of spellcheck scope. Its source is `keyboard`, `scope`, or `manual`, and every selection has a generation. A changed generation invalidates pending completion. Keyboard language can select suggestions but cannot change document language or suppress a scope-owned spelling issue.

## Revision and offset safety

All public offsets are UTF-16 code-unit offsets for CodeMirror/JavaScript. The native parser reports byte ranges; Typsastra converts them through a single precomputed byte-to-UTF-16 table. Emoji and other non-BMP characters therefore occupy two public units.

Every request and response carries `documentKey` and `revision`. The client additionally uses a local generation. Results are discarded if any identity changes. A document edit clears the CodeMirror scope state immediately; syntax errors add unresolved mutations through the enclosing lexical remainder, preventing the previous valid scope from surviving an incomplete edit.

## Static/dynamic boundary

Typsastra does not evaluate Typst in the editor language-tools path. Variables, functions, imports, closures, dynamic conditions, spread dictionaries, show-rule selection, and other computed style changes remain dynamic. This is a correctness boundary, not a parser limitation: later phases may obtain trustworthy evaluated context from Tinymist, but must never replace an unresolved value with a guess.

