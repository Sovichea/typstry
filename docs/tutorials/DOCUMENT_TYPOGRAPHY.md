# Document typography

## Why use it?

A normal Typst fallback stack applies the same size to every font:

```typst
#set text(font: ("MiSans Khmer", "MiSans Latin"), size: 11pt)
```

This creates two practical problems:

- fonts for different scripts may look mismatched at the same point size;
- a font listed first may contain another script and prevent that script's
  intended font from being used.

Typsastra solves both without rewriting document content. Each script receives
its own font, Unicode coverage restriction, and optional visual scale.

## Configure script fonts

1. Open **Document Typography** from the `Aa` toolbar button.
2. Set the shared document size.
3. Add each script used by the document.
4. Choose its installed font and adjust its scale if necessary.
5. Choose **Apply to document**, or **Apply as template** for shared project
   typography.

For example:

```text
Document size  11pt
Khmer          MiSans Khmer    0.95×
Latin          MiSans Latin    1.10×
Arabic         MiSans Arabic   1.00×
```

There is no primary script. The entries may appear in any order. Typsastra
generates a native Typst descriptor such as:

```typst
(name: "MiSans Khmer", covers: regex("\p{scx=Khmer}"))
```

`scx` means Unicode Script Extensions. The restriction prevents a Khmer font's
built-in Latin glyphs from taking ownership of Latin text. It also avoids the
regex show rules that would interfere with forward and inverse sync.

Typsastra asks for confirmation before generating a scaled font. Generated
fonts live under `.typsastra/fonts/generated`; they are local, disposable, and
excluded from project exports.

Keep script scales between `0.90×` and `1.10×` when possible. Typsastra warns
before applying a larger adjustment because this control is for fine optical
balancing, not for doubling the font size. Results beyond ±10% vary between
fonts and may not be represented accurately.

> **PDF limitation:** Non-`1.0` scales are experimental. Typst may normalize a
> scaled font while creating a PDF subset, producing unscaled glyph outlines
> with scaled spacing. Typsastra does not post-process the PDF or make preview
> differ from export. Use `1.0` for dependable PDF output and inspect every
> exported PDF when testing another scale.

## What this does not control

Script-font assignments do not change:

- the source editor's font;
- Typst `lang` or `dir`;
- spellcheck, segmentation, or completion providers;
- the Language Tools **Embedded spellcheck** setting.

For implementation details and limitations, see
[Document typography](../DOCUMENT_TYPOGRAPHY.md). Try
`02-multilingual-writing/01-script-font-assignments`.
