import { invoke } from "@tauri-apps/api/core";
import { resolveLanguageScopes } from "./resolver";
import type {
  LanguageScopeExtraction,
  ResolvedLanguageScopes,
  RootLanguageContext,
} from "./types";

export type LanguageScopeInvoke = (request: {
  documentKey: string;
  revision: number;
  text: string;
}) => Promise<LanguageScopeExtraction>;

const nativeInvoke: LanguageScopeInvoke = (request) =>
  invoke<LanguageScopeExtraction>("extract_typst_language_scopes", { request });

export class LanguageScopeClient {
  private generation = 0;

  constructor(
    private readonly extract: LanguageScopeInvoke = nativeInvoke,
    private readonly debounceMs = 120,
  ) {}

  cancel(): void {
    this.generation += 1;
  }

  analyze(
    documentKey: string,
    revision: number,
    text: string,
    rootContext: RootLanguageContext = "main",
  ): Promise<ResolvedLanguageScopes | null> {
    const generation = ++this.generation;
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        if (generation !== this.generation) {
          resolve(null);
          return;
        }
        void this.extract({ documentKey, revision, text }).then(
          (extraction) => {
            if (generation !== this.generation
              || extraction.documentKey !== documentKey
              || extraction.revision !== revision) {
              resolve(null);
              return;
            }
            resolve(resolveLanguageScopes(extraction, rootContext));
          },
          (error: unknown) => {
            if (generation !== this.generation) resolve(null);
            else reject(error);
          },
        );
      }, this.debounceMs);
    });
  }
}
