#set page(width: 20cm, height: 17cm, margin: (x: 1.2cm, top: 1cm, bottom: 1cm))

#set document(
  title: "Khmer Justification and Segmentation Comparison",
  author: "Typstella Examples",
)

// typstella:typography:start
#set text(font: ("MiSans Latin", "MiSans Khmer"), size: 10pt)
// typstella:typography:end

#align(center)[
  #text(size: 14pt, weight: "bold", fill: rgb("#1d3557"))[
    Khmer Justification and Segmentation Comparison
  ]
]

#v(0.3em)

This example compares the same Khmer paragraph under three Typst settings. The recommended default is Typst justification with tuned `justification-limits`. Typstella's native Khmer render preparation is experimental and off by default; enable it in Settings only when you want to compare inserted Zero Width Space boundaries.

#v(0.8em)

#grid(
  columns: (1fr, 1fr, 1fr),
  gutter: 14pt,
  align: top,
  [
    #block(
      fill: rgb("#f8fafc"),
      inset: 9pt,
      radius: 4pt,
      stroke: rgb("#cbd5e1"),
      width: 100%,
      [
        #align(center)[#strong[1. justify only]]
        #v(0.35em)
        #set text(size: 8.8pt)
        #set par(justify: true)
        // @disable-render-prep

        ភាសាខ្មែរគឺជាភាសាផ្លូវការរបស់ប្រទេសកម្ពុជា។ ប្រជាជនខ្មែរប្រើប្រាស់ភាសានេះក្នុងជីវិតប្រចាំថ្ងៃ ទាំងក្នុងវិស័យអប់រំ សេដ្ឋកិច្ច និងវប្បធម៌។ ការអភិវឌ្ឍប្រព័ន្ធបច្ចេកវិទ្យាព័ត៌មានវិទ្យាដែលគាំទ្រភាសាខ្មែរ ជាអាទិភាពដ៏សំខាន់ក្នុងការអភិវឌ្ឍប្រទេស។ និស្សិតសិក្សានៅសាកលវិទ្យាល័យភូមិន្ទភ្នំពេញតែងខិតខំប្រឹងប្រែង។
      ],
    )
  ],
  [
    #block(
      fill: rgb("#f0fdf4"),
      inset: 9pt,
      radius: 4pt,
      stroke: rgb("#86efac"),
      width: 100%,
      [
        #align(center)[#strong[2. experimental ZWSP prep]]
        #v(0.35em)
        #set text(size: 8.8pt)
        #set par(justify: true)

        ភាសាខ្មែរគឺជាភាសាផ្លូវការរបស់ប្រទេសកម្ពុជា។ ប្រជាជនខ្មែរប្រើប្រាស់ភាសានេះក្នុងជីវិតប្រចាំថ្ងៃ ទាំងក្នុងវិស័យអប់រំ សេដ្ឋកិច្ច និងវប្បធម៌។ ការអភិវឌ្ឍប្រព័ន្ធបច្ចេកវិទ្យាព័ត៌មានវិទ្យាដែលគាំទ្រភាសាខ្មែរ ជាអាទិភាពដ៏សំខាន់ក្នុងការអភិវឌ្ឍប្រទេស។ និស្សិតសិក្សានៅសាកលវិទ្យាល័យភូមិន្ទភ្នំពេញតែងខិតខំប្រឹងប្រែង។
      ],
    )
  ],
  [
    #block(
      fill: rgb("#eff6ff"),
      inset: 9pt,
      radius: 4pt,
      stroke: rgb("#93c5fd"),
      width: 100%,
      [
        #align(center)[#strong[3. recommended tracking limit]]
        #v(0.35em)
        #set text(size: 8.8pt)
        #set par(
          justify: true,
          justification-limits: (
            spacing: (min: 85%, max: 115%),
            tracking: (min: -0.8pt, max: 0pt),
          ),
        )
        // @disable-render-prep

        ភាសាខ្មែរគឺជាភាសាផ្លូវការរបស់ប្រទេសកម្ពុជា។ ប្រជាជនខ្មែរប្រើប្រាស់ភាសានេះក្នុងជីវិតប្រចាំថ្ងៃ ទាំងក្នុងវិស័យអប់រំ សេដ្ឋកិច្ច និងវប្បធម៌។ ការអភិវឌ្ឍប្រព័ន្ធបច្ចេកវិទ្យាព័ត៌មានវិទ្យាដែលគាំទ្រភាសាខ្មែរ ជាអាទិភាពដ៏សំខាន់ក្នុងការអភិវឌ្ឍប្រទេស។ និស្សិតសិក្សានៅសាកលវិទ្យាល័យភូមិន្ទភ្នំពេញតែងខិតខំប្រឹងប្រែង។
      ],
    )
  ],
)

#v(0.75em)

#block(
  fill: rgb("#f8fafc"),
  inset: 8pt,
  radius: 4pt,
  width: 100%,
  [
    #set text(size: 8.5pt)
    - *Column 1*: `// @disable-render-prep` keeps Typstella from inserting Khmer layout controls, so this shows Typst's original justified output.
    - *Column 2*: Shows experimental Typstella Zero Width Space insertion only when `Khmer render preparation (experimental)` is enabled in Settings.
    - *Column 3*: Recommended default: no render preparation, with bounded spacing and slight negative tracking through `justification-limits`.
  ],
)
