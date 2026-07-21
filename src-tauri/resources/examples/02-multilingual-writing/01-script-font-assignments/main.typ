#set document(title: "Script-Specific Font Assignments")
#set page(margin: 24mm)
// typsastra:typography:start
// typsastra:script-fonts [{"family":"MiSans Khmer","script":"khmer","scale":1},{"family":"MiSans Latin","script":"latin","scale":1},{"family":"MiSans Arabic","script":"arabic","scale":1}]
#set text(
  font: (
    (name: "MiSans Khmer", covers: regex("\p{scx=Khmer}")),
    (name: "MiSans Latin", covers: regex("\p{scx=Latin}")),
    (name: "MiSans Arabic", covers: regex("\p{scx=Arabic}")),
  ),
  size: 11pt,
)
// typsastra:typography:end
#set heading(numbering: "1.")
#set text(lang: "en")

= Script-specific font assignments

Typst applies one size to every family in a normal font fallback stack. Fonts
for different scripts may therefore look unbalanced at the same point size.

A second problem appears when a script font includes extra glyphs. MiSans Khmer
contains Latin characters, so placing it first in an unrestricted stack can
prevent MiSans Latin from being used.

== Typsastra's solution

Document Typography assigns a font and optional scale to each script. No entry
is primary or embedded. In this example Khmer intentionally comes before Latin.
The order is safe because each entry has a native Typst `covers` restriction:

```typ
(name: "MiSans Khmer", covers: regex("\p{scx=Khmer}"))
```

`scx` means Unicode Script Extensions. MiSans Khmer is eligible for Khmer text,
but its built-in Latin glyphs cannot consume Latin text. Latin reaches the Latin
assignment even though it appears later.

== Independent visual scaling

Open the `Aa` toolbar control and try these values:

```text
Khmer  MiSans Khmer   0.95×
Latin  MiSans Latin   1.10×
Arabic MiSans Arabic  1.00×
```

Typsastra prepares uniformly scaled local fonts without wrapping or replacing
source runs. Forward and inverse synchronization therefore retain the original
source ownership.

Non-unit scales are experimental for PDF output. Typst may normalize a scaled
font while subsetting it, leaving scaled advances with unscaled outlines.
Typsastra keeps preview faithful to the exported PDF; use `1.0` when dependable
PDF output is required.

== Example scripts

Latin uses its assigned family: Multilingual documents should remain readable.

#text(lang: "km")[ខ្មែរប្រើពុម្ពអក្សរដែលបានកំណត់សម្រាប់អក្សរខ្មែរ។]

#text(lang: "ar", dir: rtl)[يستخدم النص العربي الخط المخصص للكتابة العربية.]

== Important boundaries

Script-font assignments do not control the source-editor font, spellcheck,
completion, Typst `lang`, or text direction. Generated scaled fonts stay in
Typsastra's private global cache and never enter the project or its exports.
