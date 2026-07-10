export type LanguageSupportLevel = "basic" | "enhanced" | "deep";
export type ProviderStability = "stable" | "experimental";

export type LanguageProviderCapabilities = {
  id: string;
  pattern: string;
  displayName?: string;
  languageTag?: string;
  engine?: string;
  supportLevel?: LanguageSupportLevel | string;
  stability?: ProviderStability | string;
  boundaryMode?: string;
  supportsSpellcheck?: boolean;
  supportsCorrections?: boolean;
  supportsCompletion?: boolean;
  hasEditingPolicy?: boolean;
};

export type LanguageCatalogCapabilities = Omit<LanguageProviderCapabilities, "pattern"> & {
  locale: string;
  displayName: string;
  languageTag: string;
  installed: boolean;
  bundled: boolean;
  source: string;
};

export type SupportLevelPresentation = {
  level: LanguageSupportLevel;
  label: string;
  description: string;
};

const SUPPORT_LEVELS: Record<LanguageSupportLevel, SupportLevelPresentation> = {
  basic: {
    level: "basic",
    label: "Basic",
    description: "Dictionary-backed spelling support using general text boundaries."
  },
  enhanced: {
    level: "enhanced",
    label: "Enhanced",
    description: "Adds tested language-aware boundaries, completion, or other provider-specific tooling."
  },
  deep: {
    level: "deep",
    label: "Deep",
    description: "Combines dedicated language tooling with script-aware editing and exact source-range tests."
  }
};

export function normalizeSupportLevel(value: string | undefined): LanguageSupportLevel {
  switch (value?.toLocaleLowerCase()) {
    case "deep":
      return "deep";
    case "enhanced":
    case "full":
      return "enhanced";
    default:
      return "basic";
  }
}

export function supportLevelPresentation(value: string | undefined): SupportLevelPresentation {
  return SUPPORT_LEVELS[normalizeSupportLevel(value)];
}

export function providerStabilityLabel(value: string | undefined): string {
  return value?.toLocaleLowerCase() === "experimental" ? "Experimental" : "Stable";
}

export function providerFeatureLabels(provider: Pick<LanguageProviderCapabilities,
  "supportsSpellcheck" | "supportsCorrections" | "supportsCompletion" | "hasEditingPolicy">): string[] {
  const features: string[] = [];
  if (provider.supportsSpellcheck !== false) features.push("Spellcheck");
  if (provider.supportsCorrections === true) features.push("Corrections");
  if (provider.supportsCompletion === true) features.push("Word completion");
  if (provider.hasEditingPolicy === true) features.push("Script-aware editing");
  return features;
}

export function boundaryModeLabel(value: string | undefined): string | null {
  switch (value) {
    case "custom-segmenter":
      return "Dedicated segmenter";
    case "unicode-word":
      return "General word boundaries";
    case "whitespace":
      return "Whitespace boundaries";
    default:
      return value ? value.split("-").join(" ") : null;
  }
}
