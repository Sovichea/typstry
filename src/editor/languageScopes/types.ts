export type ValueConfidence = "static" | "dynamic";
export type MutationKind = "setRule" | "textCall" | "showRule" | "syntaxError";
export type ContentMode = "typstSource" | "plainText";

export interface SourceRange {
  fromUtf16: number;
  toUtf16: number;
}

export interface ExtractedStyleValue {
  confidence: ValueConfidence;
  /** Null is a static `none` when confidence is static, unresolved otherwise. */
  value: string | null;
}

export interface TextStyleMutation {
  kind: MutationKind;
  applyFromUtf16: number;
  applyToUtf16: number;
  declarationFromUtf16: number;
  declarationToUtf16: number;
  diagnosticFromUtf16: number;
  diagnosticToUtf16: number;
  order: number;
  language?: ExtractedStyleValue;
  region?: ExtractedStyleValue;
  script?: ExtractedStyleValue;
  contentMode: ContentMode;
}

export interface LanguageScopeExtraction {
  documentKey: string;
  revision: number;
  parserVersion: string;
  documentUtf16: number;
  mutations: TextStyleMutation[];
  proseRanges: SourceRange[];
  syntaxErrors: SourceRange[];
  elapsedMicros: number;
}

export interface EffectiveStyleField {
  confidence: ValueConfidence;
  value: string | null;
}

export interface EffectiveLanguageStyle {
  language: EffectiveStyleField;
  region: EffectiveStyleField;
  script: EffectiveStyleField;
}

export interface EffectiveLanguageRange extends SourceRange {
  style: EffectiveLanguageStyle;
  sourceKind: MutationKind | "default" | "inherited";
  declaration?: SourceRange;
}

export interface ResolvedLanguageScopes {
  documentKey: string;
  revision: number;
  documentUtf16: number;
  parserVersion: string;
  ranges: EffectiveLanguageRange[];
  proseRanges: SourceRange[];
  syntaxErrors: SourceRange[];
}

export type RootLanguageContext = "main" | "inherited";

export type ProviderAvailability =
  | "installed"
  | "disabled"
  | "downloadable"
  | "unsupported"
  | "invalid"
  | "dynamic";

export interface LanguageProviderResolution {
  requestedLanguage: string | null;
  requestedRegion: string | null;
  canonicalLocale: string | null;
  providerId: string | null;
  availability: ProviderAvailability;
}

export type InputLanguageSource = "keyboard" | "scope" | "manual";

export interface InputLanguageSelection {
  source: InputLanguageSource;
  language: string | null;
  region: string | null;
  generation: number;
}

export type AcceptedTermScope = "global" | "project" | "languageFamily";

export interface AcceptedTermRecord {
  term: string;
  scope: AcceptedTermScope;
  languageFamily?: string;
  exactCase: boolean;
}

export const LANGUAGE_SCOPE_CONTRACT_VERSION = 1;

