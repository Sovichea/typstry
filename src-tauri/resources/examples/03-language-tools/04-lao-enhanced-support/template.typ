#let lao_document(body) = {
  // typsastra:typography:start
  set text(font: ("MiSans Latin", "Noto Sans Lao", "Phetsarath OT"), size: 11pt)
  // typsastra:typography:end
  
  set page(
    margin: 25mm,
    header: align(right)[
      #text(size: 9pt, fill: luma(120))[ເອກະສານລາວ - Lao Document]
    ],
    footer: context {
      let page_number = counter(page).get().first()
      align(center)[#text(size: 10pt)[#page_number]]
    },
  )

  set par(justify: true, leading: 0.9em)
  set heading(numbering: "1.")

  align(center)[
    #text(size: 18pt, weight: "bold")[ເອກະສານລາວ - Lao Document]
  ]
  
  v(1cm)
  body
}
