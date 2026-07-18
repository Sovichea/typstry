# Document typography

Typsastra models document fonts as one primary script and zero or more embedded
scripts. The primary font leads an ordered Typst fallback stack; embedded fonts
follow in their configured order. A managed document block has this shape:

```typst
// typsastra:typography:start
// typsastra:font-roles {"primary":{"family":"MiSans Latin","script":"latin"},"embedded":[{"family":"MiSans Khmer","script":"khmer","scale":1.05},{"family":"MiSans Arabic","script":"arabic","scale":1}]}
#set text(font: ("MiSans Latin", "MiSans Khmer", "MiSans Arabic"), size: 11pt)
// typsastra:typography:end
```

The metadata comment is ignored by Typst. It records which script owns each
font role and lets Typsastra reproduce preview-only embedded-font scales while
keeping the source portable. Compiling outside Typsastra uses the same ordered
font stack with the original system fonts at their original scales.

The primary script is not assumed to be Latin. A Khmer-first document can use
Khmer as primary and add Latin and Arabic as embedded scripts. Automatic
detection orders scripts by the number of matching characters, but the author
can change the primary role and embedded order explicitly.

## Why roles use an ordered stack

Typst chooses the first font in the stack that contains each required glyph.
The script metadata lets Typsastra offer compatible installed fonts and retain
the author's intent. It does not reconstruct source text or force every script
run through a show rule. A broad primary font may therefore supply glyphs for
an embedded script when it already covers them; authors who require strict
typeface separation should select a primary family with the intended coverage.

## Why Typsastra does not use a regex show rule

A rule such as the following reconstructs every match as generated content:

```typst
#show regex("\p{Khmer}+"): set text(font: "MiSans Khmer")
```

That changes source ownership in Typst's rendered frame. Inverse sync can then resolve a click to the match or paragraph boundary instead of the original character. Ordered fallback families select glyphs without replacing source content, so forward and inverse source mapping remain intact.

## Uniform scaling

The typography toolbar accepts a uniform embedded-script scale from `0.5` to
`2.0`. A scale of `1.05` enlarges that embedded font by five percent in both
dimensions. The primary font uses the configured base point size directly.

When the scale differs from `1.0`, Typsastra:

1. locates every installed TTF or OTF face in the selected family;
2. creates a uniformly scaled copy by changing the OpenType units-per-em value;
3. recalculates the `head` table and whole-font checksums;
4. writes the results and a manifest under `.typsastra/fonts/generated/`;
5. restarts Tinymist with that directory in `TYPST_FONT_PATHS`.

Changing units-per-em scales outlines, advances, vertical metrics, and Khmer OpenType positioning anchors together. Typsastra does not scale outlines independently because that would misalign dependent vowels and subscript consonants.

Generated fonts retain their original internal family names. Typst gives the workspace font directory priority over system fonts during Typsastra rendering. The generated directory contains a `.gitignore` rule and should never be committed or exported. Typsastra project and source ZIP exports never include font binaries, so recipients must install required fonts separately.

OpenType collections (`.ttc` and `.otc`) are not transformed in the initial implementation. Select an individual TTF or OTF face instead.

## Raw code

Typsastra does not override `raw`. Inline and block raw content continues using Typst's original raw/system font behavior. A project may add its own explicit raw styling when needed.

## Rust and WASM

The pure transformation engine lives in `crates/font-scaler`. Desktop Typsastra uses its native Rust API. The same crate exposes a WASM binding behind the `wasm` feature:

```text
cargo check --manifest-path crates/font-scaler/Cargo.toml --features wasm
```

The WASM host is responsible for providing font bytes and persisting the returned font. The transformation engine itself performs no filesystem or system-font access.
