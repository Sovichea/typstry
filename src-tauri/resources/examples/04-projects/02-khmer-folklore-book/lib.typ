#let khmer_digits(value) = {
  str(value)
    .replace("0", "០")
    .replace("1", "១")
    .replace("2", "២")
    .replace("3", "៣")
    .replace("4", "៤")
    .replace("5", "៥")
    .replace("6", "៦")
    .replace("7", "៧")
    .replace("8", "៨")
    .replace("9", "៩")
}

#let khmer_justification_limits(
  spacing: (min: 85%, max: 115%),
  tracking: (min: -0.8pt, max: 0pt),
  body,
) = block[
  #set par(justification-limits: (spacing: spacing, tracking: tracking))
  #body
]
