#set document(title: "Mixed Scripts")
#set page(margin: 22mm)
// typsastra:typography:start
#set text(font: "MiSans Latin", size: 12pt)
// typsastra:typography:end
#set par(leading: 0.8em)

= Mixed Scripts

This document demonstrates several writing systems in one source file. Typsastra can detect missing script coverage and let you choose an installed or downloadable fallback font.

#let sample(name, language, content) = block(
  width: 100%,
  inset: 10pt,
  radius: 5pt,
  fill: luma(245),
  [*#name* #h(1fr) #text(size: 9pt, fill: luma(90))[#language] \
  #content],
)

#sample("Latin", "English", [A multilingual document should remain readable and balanced.])
#sample("Greek", "Ελληνικά", [Καλημέρα κόσμε. Η τυπογραφία ενώνει γλώσσες.])
#sample("Cyrillic", "Українська", [Привіт, світе. Це багатомовний документ.])
#sample("Armenian", "Հայերեն", [Բարեւ աշխարհ։ Սա բազմալեզու փաստաթուղթ է։])
#sample("Georgian", "ქართული", [გამარჯობა მსოფლიო. ეს მრავალენოვანი დოკუმენტია.])
#sample("Ethiopic", "አማርኛ", [ሰላም ዓለም። ይህ ብዙ ቋንቋ ያለው ሰነድ ነው።])
#sample("IPA", "Pronunciation", [Typst /taɪpst/ · typography /taɪˈpɒɡrəfi/])
