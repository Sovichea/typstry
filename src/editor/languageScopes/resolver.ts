import type {
  EffectiveLanguageRange,
  EffectiveLanguageStyle,
  EffectiveStyleField,
  LanguageScopeExtraction,
  MutationKind,
  ResolvedLanguageScopes,
  RootLanguageContext,
  SourceRange,
  TextStyleMutation,
} from "./types";

const staticField = (value: string | null): EffectiveStyleField => ({ confidence: "static", value });
const dynamicField = (): EffectiveStyleField => ({ confidence: "dynamic", value: null });

function rootStyle(context: RootLanguageContext): EffectiveLanguageStyle {
  if (context === "main") {
    return {
      language: staticField("en"),
      region: staticField(null),
      script: staticField("auto"),
    };
  }
  return { language: dynamicField(), region: dynamicField(), script: dynamicField() };
}

function normalize(field: "language" | "region" | "script", value: EffectiveStyleField): EffectiveStyleField {
  if (value.confidence === "dynamic" || value.value === null) return value;
  if (field === "region") return { ...value, value: value.value.toUpperCase() };
  return { ...value, value: value.value.toLowerCase() };
}

function sameField(left: EffectiveStyleField, right: EffectiveStyleField): boolean {
  return left.confidence === right.confidence && left.value === right.value;
}

function sameStyle(left: EffectiveLanguageStyle, right: EffectiveLanguageStyle): boolean {
  return sameField(left.language, right.language)
    && sameField(left.region, right.region)
    && sameField(left.script, right.script);
}

function sourceFor(active: TextStyleMutation[]): {
  sourceKind: MutationKind | "default" | "inherited";
  declaration?: SourceRange;
} {
  const source = active.reduce<TextStyleMutation | undefined>(
    (latest, mutation) => !latest || mutation.order > latest.order ? mutation : latest,
    undefined,
  );
  return source ? {
    sourceKind: source.kind,
    declaration: {
      fromUtf16: source.declarationFromUtf16,
      toUtf16: source.declarationToUtf16,
    },
  } : { sourceKind: "default" };
}

export function resolveLanguageScopes(
  extraction: LanguageScopeExtraction,
  rootContext: RootLanguageContext = "main",
): ResolvedLanguageScopes {
  const documentEnd = Math.max(0, extraction.documentUtf16);
  const mutations = extraction.mutations.filter((mutation) =>
    mutation.applyFromUtf16 < mutation.applyToUtf16
    && mutation.applyToUtf16 > 0
    && mutation.applyFromUtf16 < documentEnd
  );
  const boundaries = new Set<number>([0, documentEnd]);
  for (const mutation of mutations) {
    boundaries.add(Math.max(0, Math.min(documentEnd, mutation.applyFromUtf16)));
    boundaries.add(Math.max(0, Math.min(documentEnd, mutation.applyToUtf16)));
  }
  const ordered = [...boundaries].sort((left, right) => left - right);
  const ranges: EffectiveLanguageRange[] = [];
  const base = rootStyle(rootContext);

  for (let index = 0; index + 1 < ordered.length; index += 1) {
    const fromUtf16 = ordered[index]!;
    const toUtf16 = ordered[index + 1]!;
    if (fromUtf16 === toUtf16) continue;
    const active = mutations
      .filter((mutation) => mutation.applyFromUtf16 <= fromUtf16 && mutation.applyToUtf16 >= toUtf16)
      .sort((left, right) => left.order - right.order);
    const style: EffectiveLanguageStyle = {
      language: { ...base.language },
      region: { ...base.region },
      script: { ...base.script },
    };
    for (const mutation of active) {
      if (mutation.language) style.language = normalize("language", mutation.language);
      if (mutation.region) style.region = normalize("region", mutation.region);
      if (mutation.script) style.script = normalize("script", mutation.script);
    }
    const source = sourceFor(active);
    if (!active.length) source.sourceKind = rootContext === "main" ? "default" : "inherited";
    const previous = ranges[ranges.length - 1];
    if (previous && previous.toUtf16 === fromUtf16 && sameStyle(previous.style, style)
      && previous.sourceKind === source.sourceKind
      && previous.declaration?.fromUtf16 === source.declaration?.fromUtf16
      && previous.declaration?.toUtf16 === source.declaration?.toUtf16) {
      previous.toUtf16 = toUtf16;
    } else {
      ranges.push({ fromUtf16, toUtf16, style, ...source });
    }
  }

  return {
    documentKey: extraction.documentKey,
    revision: extraction.revision,
    documentUtf16: documentEnd,
    parserVersion: extraction.parserVersion,
    ranges,
    proseRanges: extraction.proseRanges,
    syntaxErrors: extraction.syntaxErrors,
  };
}

/** Returns minimal changed spans, with a whole-document correctness fallback. */
export function invalidatedLanguageRanges(
  previous: ResolvedLanguageScopes | null,
  next: ResolvedLanguageScopes,
): SourceRange[] {
  if (!previous || previous.documentKey !== next.documentKey) {
    return [{ fromUtf16: 0, toUtf16: next.documentUtf16 }];
  }
  if (previous.documentUtf16 !== next.documentUtf16) {
    return [{ fromUtf16: 0, toUtf16: next.documentUtf16 }];
  }
  const boundaries = new Set<number>([0, next.documentUtf16]);
  for (const range of [...previous.ranges, ...next.ranges]) {
    boundaries.add(range.fromUtf16);
    boundaries.add(range.toUtf16);
  }
  const ordered = [...boundaries].sort((left, right) => left - right);
  const changed: SourceRange[] = [];
  for (let index = 0; index + 1 < ordered.length; index += 1) {
    const fromUtf16 = ordered[index]!;
    const toUtf16 = ordered[index + 1]!;
    const before = previous.ranges.find((range) => range.fromUtf16 <= fromUtf16 && range.toUtf16 >= toUtf16);
    const after = next.ranges.find((range) => range.fromUtf16 <= fromUtf16 && range.toUtf16 >= toUtf16);
    if (!before || !after || !sameStyle(before.style, after.style)) {
      changed.push({ fromUtf16, toUtf16 });
    }
  }
  return mergeRanges(changed);
}

function mergeRanges(ranges: SourceRange[]): SourceRange[] {
  const ordered = [...ranges].sort((left, right) => left.fromUtf16 - right.fromUtf16);
  const merged: SourceRange[] = [];
  for (const range of ordered) {
    const previous = merged[merged.length - 1];
    if (previous && range.fromUtf16 <= previous.toUtf16) {
      previous.toUtf16 = Math.max(previous.toUtf16, range.toUtf16);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}
