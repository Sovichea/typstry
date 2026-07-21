# Typsastra v0.5.1 release notes

> Draft: finalize screenshots and clean-install verification before release.

Typsastra v0.5.1 is a maintenance and learning-experience update for the
multilingual foundations introduced in v0.5.0. It makes those workflows easier
to discover while correcting provider routing and completion regressions found
after release.

## Guided examples and tutorials

- Reorganized the writable example workspace into a guided path covering
  basics, multilingual writing, language providers, research projects, and
  project portability.
- Added focused examples for script-specific font assignments,
  language-scoped spellcheck, keyboard-language completion, optional-provider
  recovery, main-file ownership, portable workspace state, and font-free export.
- Promoted the multilingual article into the research-project sequence as the
  complete v0.5.x language-tools demonstration.
- Added prerequisites, expected behavior, limitations, and tutorial links to
  non-trivial examples.
- Clarified that current Arabic and Hebrew samples demonstrate Typst rendering;
  first-class RTL editor behavior remains planned for v0.9.0.
- Added a user documentation index and task-oriented tutorials for projects,
  language tools, typography, long documents, preview synchronization, and
  project interchange.

## Document typography

- Replaced primary and embedded typography roles with equal script-font
  assignments. Every configured script can choose its own font and uniform
  scale relative to the shared document size.
- Added native Typst `covers` descriptors using Unicode Script Extensions
  (`scx`). A Khmer font that contains Latin glyphs can now appear before the
  Latin font without consuming Latin text.
- Preserved existing primary/embedded configurations through automatic metadata
  migration while writing the simpler `typsastra:script-fonts` format for new
  changes.
- Rejected conflicting scales when multiple scripts select the same internal
  font family, avoiding ambiguous generated-font resolution.
- Synchronized main-file typography directives with the typography toolbar and
  generated-font cache. Setting a main file now requests confirmation before
  preparing missing or stale scaled fonts and aborts the main-file change when
  preparation is declined or fails.
- Limited generated-font ownership to the configured main file. Editing a
  typography directive or toolbar configuration in any other file no longer
  prompts, generates fonts, or restarts Tinymist.
- Prevented unrelated non-main files from scheduling a PDF recompilation when
  edited, saved, or reloaded externally. Included and imported sources continue
  to update their configured main-document preview.
- Documented that non-unit scaling is experimental for PDF output. Typst may
  normalize a generated font during PDF subsetting while retaining its scaled
  advances, and Typsastra intentionally does not hide that upstream result with
  a preview-only or PDF-rewriting workaround.

## Language-tool fixes

- Fixed completion for typed-script languages on Linux and other supported
  platforms.
- Restored Khmer word completion when its provider is selected from the active
  typing context.
- Kept an explicit static language authoritative when an included file inherits
  a dynamic region, preventing English spellcheck from leaking into French and
  Spanish scopes.
- Restored missing-provider hints and gutter warnings for unavailable explicit
  language scopes.
- Rejected stale or mismatched provider results before they reach the editor.
- Added an optional developer log category for spellcheck and language-scope
  routing, and aligned wrapped-line warnings with the first visual line.

## Validation

- Added cross-platform CI for documentation links, bundled example compilation,
  writable-example migration, package hygiene, and language-scope fixtures.
- Added guards preventing generated PDFs, preview caches, and font binaries from
  entering the bundled example workspace.
- Verified that all 20 bundled `main.typ` entry points compile with Typst 0.15.1.

## Upgrade behavior

Typsastra installs the reorganized learning path beside the existing writable
examples. Untouched retired examples are removed. Any retired example that the
user edited remains in place as a user-owned legacy copy and is never silently
overwritten.

## Known boundaries

- Optional language providers must still be installed before their explicit
  scopes receive spellcheck or completion.
- Keyboard-language completion reliability depends on the operating system's
  keyboard-layout reporting; Settings shows the active fallback policy.
- First-class RTL editing remains scheduled for v0.9.0.
- Fonts remain external dependencies and are never included in project exports.
