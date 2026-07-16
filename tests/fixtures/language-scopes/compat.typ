#set text(lang: "en", script: "latn")

= Language scope compatibility <target>

#text(lang: "fr", region: "FR")[Bonjour _le monde_.]

#block[
  #set text(lang: "km")
  សួស្តី ពិភពលោក។

  #text(lang: "ar", dir: rtl)[Arabic compatibility content.]
]

#[
  #set text(lang: "es") if true
  Hola mundo.
]

#text(lang: "en", "A direct string body")

Raw `#text(lang: "fr")[not a scope]` and math $x + y$ remain opaque.
