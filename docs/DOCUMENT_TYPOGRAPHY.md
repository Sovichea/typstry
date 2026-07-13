# Document typography

Typsastra uses Typst font fallback stacks instead of regular-expression show rules. A managed document block has this shape:

```typst
// typsastra:typography:start
// typsastra:complex-font {"family":"MiSans Khmer","script":"khmer","scale":1.05}
#set text(font: ("MiSans Latin", "MiSans Khmer"), size: 11pt)
// typsastra:typography:end
```

The metadata comment is ignored by Typst. It lets Typsastra reproduce the preview-only scale while keeping the Typst source portable. Compiling the document outside Typsastra uses the original system font at its original scale.

## Why Typsastra does not use a regex show rule

A rule such as the following reconstructs every match as generated content:

```typst
#show regex("\p{Khmer}+"): set text(font: "MiSans Khmer")
```

That changes source ownership in Typst's rendered frame. Inverse sync can then resolve a click to the match or paragraph boundary instead of the original character. Ordered fallback families select glyphs without replacing source content, so forward and inverse source mapping remain intact.

## Uniform scaling

The typography toolbar accepts a uniform complex-script scale from `0.5` to `2.0`. A scale of `1.05` enlarges the font by five percent in both dimensions.

When the scale differs from `1.0`, Typsastra:

1. locates every installed TTF or OTF face in the selected family;
2. creates a uniformly scaled copy by changing the OpenType units-per-em value;
3. recalculates the `head` table and whole-font checksums;
4. writes the results and a manifest under `.typsastra/fonts/generated/`;
5. restarts Tinymist with that directory in `TYPST_FONT_PATHS`.

Changing units-per-em scales outlines, advances, vertical metrics, and Khmer OpenType positioning anchors together. Typsastra does not scale outlines independently because that would misalign dependent vowels and subscript consonants.

Generated fonts retain their original internal family names. Typst gives the workspace font directory priority over system fonts during Typsastra rendering. The generated directory contains a `.gitignore` rule and should never be committed, particularly when the source font license restricts redistribution or modification.

OpenType collections (`.ttc` and `.otc`) are not transformed in the initial implementation. Select an individual TTF or OTF face instead.

## Raw code

Typsastra does not override `raw`. Inline and block raw content continues using Typst's original raw/system font behavior. A project may add its own explicit raw styling when needed.

## Rust and WASM

The pure transformation engine lives in `crates/font-scaler`. Desktop Typsastra uses its native Rust API. The same crate exposes a WASM binding behind the `wasm` feature:

```text
cargo check --manifest-path crates/font-scaler/Cargo.toml --features wasm
```

The WASM host is responsible for providing font bytes and persisting the returned font. The transformation engine itself performs no filesystem or system-font access.
