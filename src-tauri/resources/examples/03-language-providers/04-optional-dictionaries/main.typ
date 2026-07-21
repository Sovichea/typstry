#set document(title: "Optional Language Providers")
#set page(margin: 24mm)
// typsastra:typography:start
// typsastra:document-scripts [{"family":"New Computer Modern","script":"latin","scale":1,"language":"fr-FR"},{"family":"MiSans Arabic","script":"arabic","scale":1,"language":"ar"}]
#set text(
  font: (
    (name: "New Computer Modern", covers: regex("\p{scx=Latin}")),
    (name: "MiSans Arabic", covers: regex("\p{scx=Arabic}")),
  ),
  size: 11pt,
)
// typsastra:typography:end

= Optional language providers

This document assigns French to the Latin script and Arabic to the Arabic
script. Both providers are optional downloads. Open Document Typography to see
their availability, then use Language Providers settings to install them.

#text(lang: "fr")[Le français reste vérifié uniquement par le fournisseur français.]

#text(lang: "ar", dir: rtl)[هذا النص يحتاج إلى مزود اللغة العربية.]

When an assigned provider is unavailable, Typsastra leaves that script
unchecked. It never substitutes another same-script dictionary. To test Spanish
instead, change the Latin language assignment to Spanish in Document Typography.
