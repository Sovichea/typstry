#let thesis(title: "Untitled Thesis", author: "Anonymous", body) = {
  // typsastra:typography:start
  set text(
    font: ((name: "New Computer Modern", covers: regex("\p{scx=Latin}")),),
    size: 11pt,
  )
  // typsastra:typography:end
  set page(margin: 28mm, numbering: "1")
  set par(justify: true, leading: 0.7em)
  set heading(numbering: "1.1")
  show heading.where(level: 1): it => pagebreak(weak: true) + it

  align(center)[
    #text(size: 20pt, weight: "bold")[#title]
    #v(8pt)
    #author
  ]
  v(18pt)
  body
}
