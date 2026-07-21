#import "lib.typ": khmer_digits

#let khmer_folklore_book(body) = {
  // typsastra:typography:start
  set text(
    font: (
      (name: "MiSans Khmer", covers: regex("\p{scx=Khmer}")),
      (name: "New Computer Modern", covers: regex("\p{scx=Latin}")),
    ),
    size: 11pt,
  )
  // typsastra:typography:end

  set page(
    paper: "a5",
    margin: (top: 2.5cm, bottom: 2.5cm, left: 2cm, right: 2cm),
    header: align(right)[
      #text(size: 8.5pt, fill: luma(120))[រឿងព្រេងនិទានខ្មែរ]
    ],
    footer: context {
      let page_number = counter(page).get().first()
      align(center)[#text(size: 9pt)[#khmer_digits(page_number)]]
    },
  )

  set par(
    justify: true,
    leading: 0.8em,
    first-line-indent: 1.5em,
    justification-limits: (
      spacing: (min: 85%, max: 115%),
      tracking: (min: -0.8pt, max: 0pt),
    ),
  )

  show heading: set text(fill: rgb("#800020"))

  body
}
