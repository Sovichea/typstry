export type LanguageSupportLevel = "basic" | "enhanced" | "deep";
export type ProviderStability = "stable" | "experimental";
export type BoundaryQuality = "general" | "tested" | "dedicated";
export type CorrectionQuality = "none" | "dictionary" | "intended-word";
export const LANGUAGE_PROVIDER_CAPABILITY_SCHEMA_VERSION = 1 as const;

type LanguageCapabilityMetadata = {
  schemaVersion: typeof LANGUAGE_PROVIDER_CAPABILITY_SCHEMA_VERSION;
  id: string;
  displayName: string;
  languageTag: string;
  scripts: string[];
  supportLevel: LanguageSupportLevel;
  stability: ProviderStability;
  boundaryMode: string;
  boundaryQuality: BoundaryQuality;
  correctionQuality: CorrectionQuality;
  supportsSpellcheck: boolean;
  supportsCorrections: boolean;
  supportsCompletion: boolean;
  supportsSegmentation: boolean;
  supportsCustomDictionary: boolean;
  hasEditingPolicy: boolean;
  providerType: "dictionary-only" | "dictionary-plus-tokenizer" | "deep";
  version: string;
  license: string;
};

export type LanguageProviderCapabilities = LanguageCapabilityMetadata & {
  pattern: string;
  engine: string;
};

export type LanguageCatalogCapabilities = LanguageCapabilityMetadata & {
  locale: string;
  installed: boolean;
  bundled: boolean;
  source: string;
  downloadSize: number;
  checksum: string;
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
  "supportsSpellcheck" | "supportsCorrections" | "supportsCompletion" | "supportsSegmentation"
  | "supportsCustomDictionary" | "hasEditingPolicy">): string[] {
  const features: string[] = [];
  if (provider.supportsSpellcheck !== false) features.push("Spellcheck");
  if (provider.supportsCorrections === true) features.push("Corrections");
  if (provider.supportsCompletion === true) features.push("Word completion");
  if (provider.supportsSegmentation === true) features.push("Segmentation");
  if (provider.supportsCustomDictionary === true) features.push("Personal dictionary");
  if (provider.hasEditingPolicy === true) features.push("Script-aware editing");
  return features;
}

export function boundaryModeLabel(value: string | undefined): string | null {
  switch (value) {
    case "custom-segmenter":
      return "Dedicated segmenter";
    case "unicode-word":
      return "General word boundaries";
    case "icu4x-dictionary":
      return "ICU4X dictionary tokenizer";
    case "whitespace":
      return "Whitespace boundaries";
    default:
      return value ? value.split("-").join(" ") : null;
  }
}

export function parseLanguageProviderCapabilitiesList(value: unknown): LanguageProviderCapabilities[] {
  if (!Array.isArray(value)) throw new Error("Language provider capabilities must be an array.");
  return rejectDuplicateIds(
    value.map((entry, index) => parseLanguageProviderCapabilities(entry, `providers[${index}]`)),
    "provider"
  );
}

export function parseLanguageCatalog(value: unknown): LanguageCatalogCapabilities[] {
  if (!Array.isArray(value)) throw new Error("Language catalog must be an array.");
  return rejectDuplicateIds(value.map((entry, index) => {
    const path = `catalog[${index}]`;
    const record = capabilityRecord(entry, path);
    return {
      ...parseCapabilityMetadata(record, path),
      locale: requiredString(record, "locale", path),
      installed: requiredBoolean(record, "installed", path),
      bundled: requiredBoolean(record, "bundled", path),
      source: requiredString(record, "source", path),
      downloadSize: requiredNumber(record, "downloadSize", path),
      checksum: optionalString(record, "checksum", path)
    };
  }), "catalog entry");
}

export function supplementalLanguageProviders(
  catalog: readonly Pick<LanguageCatalogCapabilities, "id">[],
  installed: readonly LanguageProviderCapabilities[],
): LanguageProviderCapabilities[] {
  const catalogIds = new Set(catalog.map(entry => entry.id.toLocaleLowerCase()));
  return installed.filter(provider => !catalogIds.has(provider.id.toLocaleLowerCase()));
}

function parseLanguageProviderCapabilities(value: unknown, path: string): LanguageProviderCapabilities {
  const record = capabilityRecord(value, path);
  return {
    ...parseCapabilityMetadata(record, path),
    pattern: requiredString(record, "pattern", path),
    engine: requiredString(record, "engine", path)
  };
}

function parseCapabilityMetadata(record: Record<string, unknown>, path: string): LanguageCapabilityMetadata {
  const schemaVersion = record.schemaVersion;
  if (schemaVersion !== LANGUAGE_PROVIDER_CAPABILITY_SCHEMA_VERSION) {
    throw new Error(`${path}.schemaVersion must be ${LANGUAGE_PROVIDER_CAPABILITY_SCHEMA_VERSION}.`);
  }
  const supportLevel = requiredEnum(record, "supportLevel", ["basic", "enhanced", "deep"] as const, path);
  const stability = requiredEnum(record, "stability", ["stable", "experimental"] as const, path);
  const boundaryQuality = requiredEnum(record, "boundaryQuality", ["general", "tested", "dedicated"] as const, path);
  const correctionQuality = requiredEnum(
    record,
    "correctionQuality",
    ["none", "dictionary", "intended-word"] as const,
    path
  );
  const supportsCorrections = requiredBoolean(record, "supportsCorrections", path);
  if (supportsCorrections !== (correctionQuality !== "none")) {
    throw new Error(`${path} has inconsistent correction capability metadata.`);
  }
  const scripts = requiredStringArray(record, "scripts", path);
  if (scripts.some(script => !/^[A-Z][a-z]{3}$/.test(script))) {
    throw new Error(`${path}.scripts must contain ISO 15924 codes.`);
  }
  const providerType = requiredEnum(record, "providerType", ["dictionary-only", "dictionary-plus-tokenizer", "deep"] as const, path);
  return {
    schemaVersion,
    id: requiredString(record, "id", path),
    displayName: requiredString(record, "displayName", path),
    languageTag: requiredString(record, "languageTag", path),
    scripts,
    supportLevel,
    stability,
    boundaryMode: requiredString(record, "boundaryMode", path),
    boundaryQuality,
    correctionQuality,
    supportsSpellcheck: requiredBoolean(record, "supportsSpellcheck", path),
    supportsCorrections,
    supportsCompletion: requiredBoolean(record, "supportsCompletion", path),
    supportsSegmentation: requiredBoolean(record, "supportsSegmentation", path),
    supportsCustomDictionary: requiredBoolean(record, "supportsCustomDictionary", path),
    hasEditingPolicy: requiredBoolean(record, "hasEditingPolicy", path),
    providerType,
    version: requiredString(record, "version", path),
    license: requiredString(record, "license", path)
  };
}

function rejectDuplicateIds<T extends { id: string }>(entries: T[], label: string): T[] {
  const ids = new Set<string>();
  for (const entry of entries) {
    if (ids.has(entry.id)) throw new Error("Duplicate " + label + " ID '" + entry.id + "'.");
    ids.add(entry.id);
  }
  return entries;
}

function capabilityRecord(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requiredString(record: Record<string, unknown>, key: string, path: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) throw new Error(`${path}.${key} must be a non-empty string.`);
  return value;
}

function optionalString(record: Record<string, unknown>, key: string, path: string): string {
  const value = record[key];
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new Error(`${path}.${key} must be a string.`);
  return value;
}

function requiredBoolean(record: Record<string, unknown>, key: string, path: string): boolean {
  const value = record[key];
  if (typeof value !== "boolean") throw new Error(`${path}.${key} must be a boolean.`);
  return value;
}

function requiredNumber(record: Record<string, unknown>, key: string, path: string): number {
  const value = record[key];
  if (typeof value !== "number" || isNaN(value)) throw new Error(`${path}.${key} must be a number.`);
  return value;
}

function requiredStringArray(record: Record<string, unknown>, key: string, path: string): string[] {
  const value = record[key];
  if (!Array.isArray(value) || value.length === 0 || value.some(item => typeof item !== "string" || item.length === 0)) {
    throw new Error(`${path}.${key} must be a non-empty string array.`);
  }
  return [...value] as string[];
}

function requiredEnum<const T extends readonly string[]>(
  record: Record<string, unknown>,
  key: string,
  options: T,
  path: string
): T[number] {
  const value = record[key];
  if (typeof value !== "string" || !options.includes(value)) {
    throw new Error(`${path}.${key} must be one of: ${options.join(", ")}.`);
  }
  return value as T[number];
}
