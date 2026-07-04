#set document(
  title: "រឿងព្រេងនិទានខ្មែរ",
  author: "Typstry Examples",
)

// typstry:typography:start
#set text(font: "MiSans Latin", size: 11pt)
#show regex("[\u1780-\u17ff]+"): set text(font: "MiSans Khmer", size: 1.05em, lang: "km", hyphenate: true)
// typstry:typography:end

#set page(
  paper: "a5",
  margin: (top: 2.5cm, bottom: 2.5cm, left: 2cm, right: 2cm),
  header: align(right)[
    #text(size: 8.5pt, fill: luma(120))[រឿងព្រេងនិទានខ្មែរ]
  ],
  footer: context {
    let page_number = counter(page).get().first()
    align(center)[#text(size: 9pt)[#page_number]]
  },
)

#set par(justify: true, leading: 0.8em, first-line-indent: 1.5em)
#show heading: set text(fill: rgb("#800020"))

#align(center + horizon)[
  #v(-2cm)
  #text(size: 20pt, weight: "bold", fill: rgb("#800020"))[រឿងព្រេងនិទានខ្មែរ]

  #v(1cm)
  #text(size: 16pt, weight: "medium")[ទន្សាយ និងខ្យង]

  #v(0.5cm)
  #text(size: 13pt, weight: "medium")[ក្តាម និងកុក]

  #v(0.5cm)
  #text(size: 13pt, weight: "medium")[ឪពុកចាស់ និងកូនប្រុសបីនាក់]

  #v(1.5cm)
  #text(size: 10pt, style: "italic", fill: luma(100))[រក្សាសិទ្ធិដោយ Typstry Examples]
]

#pagebreak()

= សេចក្តីផ្តើម

រឿងព្រេងនិទានខ្មែរ គឺជារតនសម្បត្តិវប្បធម៌ដ៏មានតម្លៃ ដែលត្រូវបាននិទានតៗគ្នាចាប់តាំងពីបុរាណកាលមក។ រឿងនីមួយៗមិនត្រឹមតែផ្តល់នូវការកម្សាន្តសប្បាយប៉ុណ្ណោះទេ ប៉ុន្តែថែមទាំងបង្កប់នូវទស្សនវិជ្ជាជីវិត អប់រំសីលធម៌ និងការប្រុងប្រយ័ត្នខ្ពស់ក្នុងការរស់នៅក្នុងសង្គម។

នៅក្នុងសៀវភៅដ៏តូចនេះ យើងសូមលើកយករឿងព្រេងនិទានខ្មែរចំនួនបីមកបង្ហាញ។ រឿងទាំងនេះមានទម្រង់ខ្លី ងាយអាន និងសមស្របសម្រាប់សាកល្បងឯកសារ Typst ពហុឯកសារ ជាមួយអត្ថបទខ្មែរដែលត្រូវការការតម្រឹមបន្ទាត់ និងការបំបែកពាក្យឱ្យបានត្រឹមត្រូវ។

#pagebreak()

#include "stories/01-rabbit-and-snail.typ"

#pagebreak()

#include "stories/02-crab-and-heron.typ"

#pagebreak()

#include "stories/03-three-sons.typ"
