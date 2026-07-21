import { describe, expect, test } from "bun:test";
import {
  boundaryModeLabel,
  normalizeSupportLevel,
  parseLanguageCatalog,
  parseLanguageProviderCapabilitiesList,
  providerFeatureLabels,
  providerStabilityLabel,
  supplementalLanguageProviders,
  supportLevelPresentation
} from "../src/languageSupport";

const serializedProvider = {
  schemaVersion: 1,
  id: "khmer-segmenter",
  pattern: "[\\u1780-\\u17ff]+",
  displayName: "Khmer",
  languageTag: "km",
  scripts: ["Khmr"],
  engine: "khmer_segmenter",
  providerType: "deep",
  version: "test-1",
  license: "MIT",
  supportLevel: "deep",
  stability: "experimental",
  boundaryMode: "custom-segmenter",
  boundaryQuality: "dedicated",
  correctionQuality: "none",
  supportsSpellcheck: true,
  supportsCorrections: false,
  supportsCompletion: true,
  supportsSegmentation: true,
  supportsCustomDictionary: true,
  hasEditingPolicy: true
};

describe("language support taxonomy", () => {
  test("adds bundled deep providers that are absent from the download catalog", () => {
    const [khmer] = parseLanguageProviderCapabilitiesList([serializedProvider]);
    expect(supplementalLanguageProviders([{ id: "hunspell:en_US" }], [khmer])).toEqual([khmer]);
    expect(supplementalLanguageProviders([{ id: "khmer-segmenter" }], [khmer])).toEqual([]);
  });

  test("refreshes provider-dependent UI after deferred provider startup", async () => {
    const source = await Bun.file(new URL("../src/appController.ts", import.meta.url)).text();
    expect(source).toContain('document.dispatchEvent(new CustomEvent("typsastra:language-providers-changed"))');
    expect(source).toContain("this.handleLanguageProvidersChanged(providers);");
  });

  test("normalizes legacy support values without overstating unknown providers", () => {
    expect(normalizeSupportLevel("deep")).toBe("deep");
    expect(normalizeSupportLevel("full")).toBe("enhanced");
    expect(normalizeSupportLevel("experimental")).toBe("basic");
    expect(normalizeSupportLevel(undefined)).toBe("basic");
  });

  test("defines stable public labels for every support level", () => {
    expect(supportLevelPresentation("basic").label).toBe("Basic");
    expect(supportLevelPresentation("enhanced").label).toBe("Enhanced");
    expect(supportLevelPresentation("deep").label).toBe("Deep");
  });

  test("advertises only explicitly enabled optional capabilities", () => {
    expect(providerFeatureLabels({
      id: "fallback",
      pattern: "[a-z]+",
      supportsCorrections: false,
      supportsCompletion: false,
      supportsSegmentation: false,
      supportsCustomDictionary: true,
      hasEditingPolicy: false
    })).toEqual(["Spellcheck", "Personal dictionary"]);
    expect(providerFeatureLabels({
      id: "deep",
      pattern: ".+",
      supportsSpellcheck: true,
      supportsCorrections: false,
      supportsCompletion: true,
      supportsSegmentation: true,
      supportsCustomDictionary: true,
      hasEditingPolicy: true
    })).toEqual([
      "Spellcheck",
      "Word completion",
      "Segmentation",
      "Personal dictionary",
      "Script-aware editing"
    ]);
  });

  test("keeps stability separate from support depth", () => {
    expect(providerStabilityLabel("experimental")).toBe("Experimental");
    expect(providerStabilityLabel("stable")).toBe("Stable");
    expect(boundaryModeLabel("custom-segmenter")).toBe("Dedicated segmenter");
    expect(boundaryModeLabel("icu4x-dictionary")).toBe("ICU4X dictionary tokenizer");
  });

  test("validates the versioned Rust capability payload and strips provider internals", () => {
    const [provider] = parseLanguageProviderCapabilitiesList([{
      ...serializedProvider,
      khmerInternalRankingMode: "private"
    }]);
    expect(provider.schemaVersion).toBe(1);
    expect(provider.scripts).toEqual(["Khmr"]);
    expect("khmerInternalRankingMode" in provider).toBe(false);
  });

  test("rejects unsupported schemas and inconsistent correction metadata", () => {
    expect(() => parseLanguageProviderCapabilitiesList([{
      ...serializedProvider,
      schemaVersion: 2
    }])).toThrow("schemaVersion must be 1");
    expect(() => parseLanguageProviderCapabilitiesList([{
      ...serializedProvider,
      supportsCorrections: true
    }])).toThrow("inconsistent correction capability");
    expect(() => parseLanguageProviderCapabilitiesList([
      serializedProvider,
      { ...serializedProvider }
    ])).toThrow("Duplicate provider ID");
  });

  test("validates catalog capability metadata independently from provider regexes", () => {
    const [entry] = parseLanguageCatalog([{
      ...serializedProvider,
      id: "hunspell:lo_LA",
      displayName: "Lao",
      languageTag: "lo-LA",
      scripts: ["Laoo"],
      supportLevel: "enhanced",
      stability: "experimental",
      boundaryMode: "icu4x-dictionary",
      boundaryQuality: "dedicated",
      correctionQuality: "dictionary",
      supportsCorrections: true,
      supportsCompletion: true,
      supportsSegmentation: true,
      providerType: "dictionary-plus-tokenizer",
      version: "2019.10.01",
      license: "GPL-3.0",
      hasEditingPolicy: false,
      locale: "lo_LA",
      installed: false,
      bundled: false,
      source: "LibreOffice dictionaries",
      downloadSize: 1024
    }]);
    expect(entry.supportLevel).toBe("enhanced");
    expect(entry.supportsCompletion).toBe(true);
  });
});
