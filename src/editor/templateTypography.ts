import {
  parseDocumentScripts,
  parseTypographyBlock,
  renderTypographyBlock,
  type DocumentTypography,
  type TypographyEdit
} from "./documentTypography";

export type LocalTemplateApplication = {
  functionName: string;
  importPath: string;
  showExpression: string;
};

const blockStart = "// typsastra:typography:start";
const blockEnd = "// typsastra:typography:end";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchingDelimiter(text: string, opening: number, open: string, close: string): number {
  let depth = 0;
  let quote = false;
  let escaped = false;
  for (let index = opening; index < text.length; index++) {
    const character = text[index];
    if (quote) {
      if (character === '"' && !escaped) quote = false;
      escaped = character === "\\" && !escaped;
      if (character !== "\\") escaped = false;
      continue;
    }
    if (character === '"') {
      quote = true;
      continue;
    }
    if (character === open) depth++;
    if (character === close && --depth === 0) return index;
  }
  return -1;
}

export function findLocalTemplateApplication(mainText: string): LocalTemplateApplication | null {
  const show = /#show\s*:\s*([A-Za-z_][\w-]*)/g.exec(mainText);
  if (!show) return null;
  const functionName = show[1];
  let expressionEnd = show.index + show[0].length;
  const suffix = mainText.slice(expressionEnd);
  const withMatch = /^\s*\.with\s*\(/.exec(suffix);
  if (withMatch) {
    const opening = expressionEnd + withMatch[0].lastIndexOf("(");
    const closing = matchingDelimiter(mainText, opening, "(", ")");
    if (closing < 0) return null;
    expressionEnd = closing + 1;
  }
  const showExpression = mainText.slice(show.index + show[0].indexOf(functionName), expressionEnd).trim();

  const imports = /#import\s+"((?:\\.|[^"\\])*)"\s*:\s*([^\r\n]+)/g;
  for (const imported of mainText.matchAll(imports)) {
    const importPath = imported[1];
    if (importPath.startsWith("@") || importPath.includes("://")) continue;
    if (new RegExp(`(?:^|[^\\w-])${escapeRegExp(functionName)}(?:$|[^\\w-])`).test(imported[2])) {
      return { functionName, importPath, showExpression };
    }
  }
  return null;
}

export function effectiveTemplateTypography(
  mainText: string,
  templateText: string
): DocumentTypography | null {
  const templateTypography = parseTypographyBlock(templateText);
  if (!templateTypography) return null;
  const documentScripts = parseDocumentScripts(mainText);
  return {
    baseSizePt: templateTypography.baseSizePt,
    // The main-file directive owns document language routing and script order.
    // The template owns the effective text rule, including its base size.
    fonts: documentScripts.length > 0 ? documentScripts : templateTypography.fonts
  };
}

export function findTemplateFunctionName(text: string): string | null {
  const matches = [...text.matchAll(/#let\s+([A-Za-z_][\w-]*)\s*\(/g)];
  for (const match of matches) {
    const functionName = match[1];
    const openingParenthesis = text.indexOf("(", match.index);
    const closingParenthesis = matchingDelimiter(text, openingParenthesis, "(", ")");
    if (closingParenthesis >= 0) {
      const parameters = text.slice(openingParenthesis + 1, closingParenthesis);
      if (/(?:^|[,\s])body(?:[,\s]|$)/.test(parameters)) {
        const bodyOpening = text.indexOf("{", closingParenthesis);
        if (bodyOpening >= 0 && /^\s*=\s*\{/.test(text.slice(closingParenthesis + 1, bodyOpening + 1))) {
          return functionName;
        }
      }
    }
  }
  return null;
}


export function renderTemplateTypographyBlock(config: DocumentTypography): string {
  const typographyOnly: DocumentTypography = {
    ...config,
    fonts: config.fonts.map(font => ({ ...font, language: null }))
  };
  return renderTypographyBlock(typographyOnly)
    .replace("// typsastra:document-scripts ", "// typsastra:script-fonts ")
    .trimEnd()
    .split("\n")
    .map(line => line.startsWith("#") ? `  ${line.slice(1)}` : `  ${line}`)
    .join("\n");
}

export function templateTypographyEdit(
  templateText: string,
  functionName: string,
  config: DocumentTypography
): TypographyEdit | null {
  const start = templateText.indexOf(blockStart);
  const insert = renderTemplateTypographyBlock(config);
  if (start >= 0) {
    const end = templateText.indexOf(blockEnd, start);
    if (end < 0) return null;
    const lineStart = templateText.lastIndexOf("\n", start - 1) + 1;
    return { from: lineStart, to: end + blockEnd.length, insert };
  }

  const declaration = new RegExp(`#let\\s+${escapeRegExp(functionName)}\\s*\\(`).exec(templateText);
  if (!declaration) return null;
  const openingParenthesis = templateText.indexOf("(", declaration.index);
  const closingParenthesis = matchingDelimiter(templateText, openingParenthesis, "(", ")");
  if (closingParenthesis < 0) return null;
  const parameters = templateText.slice(openingParenthesis + 1, closingParenthesis);
  if (!/(?:^|[,\s])body(?:[,\s]|$)/.test(parameters)) return null;
  const bodyOpening = templateText.indexOf("{", closingParenthesis);
  if (bodyOpening < 0 || !/^\s*=\s*\{/.test(templateText.slice(closingParenthesis + 1, bodyOpening + 1))) return null;
  return { from: bodyOpening + 1, to: bodyOpening + 1, insert: `\n${insert}\n` };
}

export function newTypographyTemplate(config: DocumentTypography): string {
  return [
    "#let typsastra-typography(body) = {",
    renderTemplateTypographyBlock(config),
    "  body",
    "}",
    ""
  ].join("\n");
}

export function ensureTypographyTemplateApplication(mainText: string): TypographyEdit {
  if (/#import\s+"typsastra-template\.typ"\s*:\s*typsastra-typography/.test(mainText)) {
    return { from: 0, to: 0, insert: "" };
  }
  const insert = '#import "typsastra-template.typ": typsastra-typography\n#show: typsastra-typography\n\n';
  const bomOffset = mainText.startsWith("\uFEFF") ? 1 : 0;
  const from = bomOffset;
  return { from, to: from, insert };
}

export function templatePreviewSource(
  application: LocalTemplateApplication,
  templateRootPath: string,
  chapterRootPath: string,
  chapterText = ""
): string {
  const externalReferences = externalReferenceLabels(chapterText);
  const placeholders = externalReferences.map(label =>
    `#show ref.where(target: <${label}>): text("⟦@${label} — see main document⟧", fill: luma(110))`
  );
  return [
    `#import "${templateRootPath}": ${application.functionName}`,
    `#show: ${application.showExpression}`,
    ...placeholders,
    `#include "${chapterRootPath}"`,
    ""
  ].join("\n");
}

export function externalReferenceLabels(chapterText: string): string[] {
  const normalizeLabel = (label: string) => label.replace(/[.:]+$/, "");
  const definedLabels = new Set(
    [...chapterText.matchAll(/<([A-Za-z0-9_.:-]+)>/g)].map(match => normalizeLabel(match[1]))
  );
  return [...new Set(
    [...chapterText.matchAll(/@([A-Za-z0-9_.:-]+)/g)]
      .map(match => normalizeLabel(match[1]))
      .filter(Boolean)
      .filter(label => !definedLabels.has(label))
  )];
}
