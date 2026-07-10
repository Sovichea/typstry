import { describe, expect, test } from "bun:test";
import {
  boundaryModeLabel,
  normalizeSupportLevel,
  providerFeatureLabels,
  providerStabilityLabel,
  supportLevelPresentation
} from "../src/languageSupport";

describe("language support taxonomy", () => {
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
      hasEditingPolicy: false
    })).toEqual(["Spellcheck"]);
    expect(providerFeatureLabels({
      id: "deep",
      pattern: ".+",
      supportsSpellcheck: true,
      supportsCorrections: false,
      supportsCompletion: true,
      hasEditingPolicy: true
    })).toEqual(["Spellcheck", "Word completion", "Script-aware editing"]);
  });

  test("keeps stability separate from support depth", () => {
    expect(providerStabilityLabel("experimental")).toBe("Experimental");
    expect(providerStabilityLabel("stable")).toBe("Stable");
    expect(boundaryModeLabel("custom-segmenter")).toBe("Dedicated segmenter");
  });
});
