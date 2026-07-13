#let project(title: "", authors: (), logo: none, body) = {
  set document(title: title, author: authors)
  set page(
    paper: "a4",
    margin: (x: 2.5cm, top: 3cm, bottom: 2.5cm),
    header: context {
      let page-number = counter(page).get().first()
      if page-number > 1 {
        align(right, text(fill: gray.darken(20%), size: 9pt)[
          #title
        ])
      }
    },
    footer: context {
      let page-number = counter(page).get().first()
      let total-pages = counter(page).final().first()
      align(center, text(fill: gray.darken(20%), size: 10pt)[
        Page #page-number of #total-pages
      ])
    },
  )
  set text(font: ("MiSans Latin", "MiSans Khmer", "Noto Sans Khmer", "Liberation Sans", "Arial"), size: 11pt)
  set par(justify: true, leading: 0.75em)

  // Title Page
  if logo != none {
    align(center)[
      #v(2cm)
      #image(logo, width: 25%)
      #v(2cm)
    ]
  }

  align(center)[
    #text(size: 26pt, weight: "bold")[#title]
    #v(1cm)
    #grid(
      columns: (1fr,) * calc.min(3, authors.len()),
      gutter: 1em,
      ..authors.map(author => align(center)[
        #text(size: 12pt, weight: "medium")[#author]
      ]),
    )
    #v(2cm)
  ]

  pagebreak()

  body
}
