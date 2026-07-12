#let multilingual-article(
  title: "Untitled Article",
  author: "Anonymous",
  date: datetime.today(),
  body,
) = {
  // typstella:typography:start
  set text(font: ("MiSans Latin", "MiSans Khmer"), size: 11pt)
  // typstella:typography:end
  set document(title: title, author: author)
  set page(
    margin: (x: 24mm, y: 22mm),
    header: context [#title #h(1fr) #counter(page).display()],
  )
  set text(size: 11pt)
  set par(justify: true, leading: 0.75em)
  set heading(numbering: "1.")

  align(center)[
    #text(size: 20pt, weight: "bold")[#title]
    #v(5pt)
    #author · #date.display("[year]-[month]-[day]")
  ]
  v(18pt)
  body
}
