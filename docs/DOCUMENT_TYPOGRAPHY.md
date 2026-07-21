# Document typography

Typsastra assigns a font and optional scale directly to each writing script.
There is no primary or embedded typography role: Latin, Khmer, Arabic, and
other scripts use the same configuration model and may be listed in any order.

## Problems addressed

Typst applies one `size` to every family in a normal fallback stack. Different
scripts can have different visual proportions, so fonts at the same nominal
point size may not look balanced.

A font may also contain glyphs for several scripts. For example, a Khmer family
may contain Latin glyphs. In an ordinary ordered stack, placing that family
first prevents the intended Latin family from being reached.

Regex show rules can force another font or size onto a script, but they
reconstruct matching content. Forward and inverse sync can then resolve to a
match or paragraph boundary instead of the intended source character. Typsastra
does not use that approach.

## Managed Typst rule

Typsastra writes native Typst font descriptors with a `covers` restriction:

```typst
// typsastra:typography:start
// typsastra:document-scripts [{"family":"MiSans Khmer","script":"khmer","scale":0.95,"language":"km"},{"family":"MiSans Latin","script":"latin","scale":1.1,"language":"en-US"},{"family":"MiSans Arabic","script":"arabic","scale":1,"language":"ar"}]
#set text(
  font: (
    (name: "MiSans Khmer", covers: regex("\p{scx=Khmer}")),
    (name: "MiSans Latin", covers: regex("\p{scx=Latin}")),
    (name: "MiSans Arabic", covers: regex("\p{scx=Arabic}")),
  ),
  size: 11pt,
)
// typsastra:typography:end
```

`scx` is the Unicode Script Extensions property. It includes characters that
Unicode associates with a script, including relevant marks that may not have
that script as their primary `Script` property.

Font coverage descriptors require Typst 0.13 or newer, matching Typsastra's
supported managed-toolchain baseline.

The `covers` restriction makes a family eligible only for its assigned script.
MiSans Khmer can therefore appear before MiSans Latin without consuming Latin
letters that happen to exist in the Khmer font. Order remains meaningful only
when two configured entries intentionally have overlapping Unicode coverage.
The Document Typography dialog lets authors drag script rows into the desired
priority order. A focused drag handle also supports Up and Down Arrow for
keyboard reordering. For a Khmer-dominant book, placing Khmer before Latin is a
useful default; order is a tie-breaker, not a primary-font or scaling role.

Spaces, generic punctuation, digits, and other Common or Inherited characters
are not always owned by one script. Typst may select their font from the
surrounding run or fallback context; script-specific letters and marks remain
restricted by the descriptors above.

The metadata comment is ignored by Typst. Typsastra uses it to restore the
toolbar configuration, prepare private cached font variants, and select one
optional language-tools provider per script. Older typography metadata is
migrated when Typsastra reads and reapplies the configuration.

## Uniform script scaling

Every script entry accepts a uniform scale from `0.5` to `2.0`, relative to the
shared document point size. For an `11pt` document, Latin can use `1.1`, Khmer
`0.95`, and Arabic `1.0`; no script has a special base-font role.

Fonts supplied internally by the Typst compiler, such as New Computer Modern,
must remain at `1.0` unless that family is also installed locally. Typsastra
cannot access or extract the compiler's embedded font files to create a scaled
variant. The typography dialog disables the scale field for these fonts. A
manually edited non-unit directive produces an error and is reset to `1.0`
instead of starting font generation. Install a local copy of the family to
enable scaling.

Typsastra treats `0.90×` through `1.10×` as the recommended fine-adjustment
range. Values outside that range require confirmation because script scaling
is intended to balance fonts optically, not to double or substantially change
the document text size. Accurate representation beyond ±10% is not guaranteed
and varies from one font to another.

When a file is selected as the project's main file, Typsastra reads its managed
typography directive before changing the preview target. If its generated font
cache is missing or no longer matches the directive, Typsastra lists the
required scales and asks for confirmation before generating fonts. Cancelling
also cancels the main-file change, so the directive, typography toolbar, font
cache, and Tinymist session cannot silently diverge. An already matching cache
does not prompt again.
Selecting a main file without a managed typography directive clears scaled
fonts left by the previous main file before Tinymist restarts.

Typography directives in non-main files are inert workspace configuration.
They can be edited through source or the typography toolbar without prompting,
generating fonts, or restarting Tinymist. Typsastra evaluates such a directive
only if that file is later selected as the project's main file.

When a scale differs from `1.0`, Typsastra:

1. locates every installed TTF or OTF face in the selected family;
2. creates a uniformly scaled copy by changing the OpenType units-per-em value;
3. recalculates the `head` table and whole-font checksums;
4. writes the result to Typsastra's private application-data font cache;
5. records the selected global variants outside the project and restarts
   Tinymist with only those variant directories in `TYPST_FONT_PATHS`.

Changing units-per-em asks the font engine to interpret outlines, advances,
vertical metrics, and OpenType positioning anchors against a different em
square. Generated fonts retain their original internal family names. The
global cache is private to the local Typsastra installation. Another project
requesting the same font and scale reuses the cached variant without rescaling.
Font bytes and machine-specific cache paths are never written under
`.typsastra`, copied with workspace settings, or included in project exports.
Recipients install the original fonts and reproduce any scale locally.
Typsastra rechecks the main-file directive before starting workspace services,
so a directive changed outside the app cannot silently reuse a stale selection.

Typsastra recommends keeping at most 10 cached scale variants per font face.
Reusing an existing variant never prompts. When a main-file change, toolbar
edit, or direct typography-directive edit would create an additional variant
after that limit, Typsastra asks for confirmation first. It does not delete an
existing variant automatically. Advanced controls for viewing, deleting, and
renewing global variants are planned for v0.5.2.

### Known Typst PDF limitation

Non-`1.0` script scaling is experimental for PDF output. Typst's PDF subsetter
may normalize a generated font back to a 1000-unit em square while retaining
advance widths calculated from the scaled font. When that happens, glyphs keep
their unscaled outlines but occupy scaled horizontal space, which looks like
excessive letter spacing. Typst does not apply this normalization consistently
to every font or scale; for example, a 2x subset may retain a 500-unit em square
while another scaled subset is normalized to 1000 units.

This behavior is reproducible with the Typst CLI and a generated font, without
Typsastra's preview layer. Typsastra therefore does not rewrite the exported
PDF or apply a preview-only correction. Preview and exported PDF intentionally
show the same result. Use `1.0` scales when reliable, portable PDF output is
required, and verify every non-unit scale in the exported PDF with the intended
PDF reader.

The managed source block remains valid Typst. Outside Typsastra, or when the
generated font cache is absent, the original installed family is used and the
metadata scale is ignored. This preserves source compatibility at the cost of
the optional visual scale not being portable.

Two assignments that use the same physical family with different scales are
not supported because both generated copies would have the same internal family
name. Choose separate families or use the same scale for those assignments.

OpenType collections (`.ttc` and `.otc`) are not transformed. Select an
individual TTF or OTF face for scaling.

## Application and boundaries

**Apply to document** inserts or replaces the managed block. **Apply as
template** updates a detected local template or creates
`typsastra-template.typ`, allowing included chapters to inherit the same rule.

Document Typography does not change CodeMirror's source-editor font or Typst
`lang` and `dir`. Its optional language selection does control Typsastra
spellcheck and word completion for the assigned script. A script with no
language is intentionally left unchecked and receives no Typsastra completion.
Typst language scopes and keyboard layouts do not override this selection.

Typsastra does not override `raw`; inline and block raw content keeps Typst's
normal raw-font behavior.

## Rust and WASM

The pure transformation engine lives in `crates/font-scaler`. Desktop
Typsastra uses its native Rust API. The same crate exposes a WASM binding behind
the `wasm` feature:

```text
cargo check --manifest-path crates/font-scaler/Cargo.toml --features wasm
```

The WASM host supplies font bytes and persists the result. The transformation
engine itself performs no filesystem or system-font access.
