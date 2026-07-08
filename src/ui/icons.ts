import {
  AlignCenter,
  AlignJustify,
  AlignRight,
  Bold,
  BookOpen,
  Braces,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleX,
  CodeXml,
  Download,
  Ellipsis,
  EllipsisVertical,
  ExternalLink,
  File,
  FileCode,
  FileCog,
  FileImage,
  FileText,
  Folder,
  Highlighter,
  Image,
  Info,
  Italic,
  Link,
  List,
  ListOrdered,
  Minus,
  NotebookText,
  PanelLeft,
  Pilcrow,
  Plus,
  Quote,
  Radical,
  Redo2,
  RefreshCw,
  Save,
  Search,
  SeparatorHorizontal,
  Sigma,
  Square,
  SquareCode,
  Strikethrough,
  Table2,
  Tag,
  TriangleAlert,
  Underline,
  Undo2,
  WrapText,
  X,
  createElement as createLucideElement,
  type IconNode,
  type SVGProps
} from "lucide";

const iconNodes = {
  alignCenter: AlignCenter,
  alignJustify: AlignJustify,
  alignRight: AlignRight,
  bold: Bold,
  bookOpen: BookOpen,
  braces: Braces,
  chevronDown: ChevronDown,
  chevronLeft: ChevronLeft,
  chevronRight: ChevronRight,
  circleX: CircleX,
  codeXml: CodeXml,
  download: Download,
  ellipsis: Ellipsis,
  ellipsisVertical: EllipsisVertical,
  externalLink: ExternalLink,
  file: File,
  fileCode: FileCode,
  fileCog: FileCog,
  fileImage: FileImage,
  fileText: FileText,
  folder: Folder,
  highlighter: Highlighter,
  image: Image,
  info: Info,
  italic: Italic,
  link: Link,
  list: List,
  listOrdered: ListOrdered,
  minus: Minus,
  notebookText: NotebookText,
  panelLeft: PanelLeft,
  pilcrow: Pilcrow,
  plus: Plus,
  quote: Quote,
  radical: Radical,
  redo: Redo2,
  refresh: RefreshCw,
  save: Save,
  search: Search,
  separatorHorizontal: SeparatorHorizontal,
  sigma: Sigma,
  square: Square,
  squareCode: SquareCode,
  strikethrough: Strikethrough,
  table: Table2,
  tag: Tag,
  triangleAlert: TriangleAlert,
  underline: Underline,
  undo: Undo2,
  wrapText: WrapText,
  x: X
} satisfies Record<string, IconNode>;

export type AppIconName = keyof typeof iconNodes;

export function createAppIcon(
  name: AppIconName,
  options: { size?: number; className?: string; color?: string; strokeWidth?: number } = {}
): SVGSVGElement {
  const size = options.size ?? 16;
  const attributes: SVGProps = {
    width: size,
    height: size,
    "stroke-width": options.strokeWidth ?? 1.8,
    "aria-hidden": "true",
    focusable: "false"
  };
  if (options.className) attributes.class = options.className;
  if (options.color) attributes.color = options.color;
  const icon = createLucideElement(iconNodes[name], attributes) as SVGSVGElement;
  return icon;
}

function replaceSvg(selector: string, icon: AppIconName, size = 14): void {
  document.querySelectorAll<SVGElement>(selector).forEach(svg => svg.replaceWith(createAppIcon(icon, { size })));
}

function replaceContents(selector: string, icon: AppIconName, size = 14): void {
  document.querySelectorAll<HTMLElement>(selector).forEach(element => element.replaceChildren(createAppIcon(icon, { size })));
}

export function initializeLucideIcons(): void {
  const toolIcons: Partial<Record<string, AppIconName>> = {
    save: "save",
    undo: "undo",
    redo: "redo",
    bold: "bold",
    italic: "italic",
    underline: "underline",
    strikethrough: "strikethrough",
    highlight: "highlighter",
    "inline-code": "codeXml",
    "code-block": "squareCode",
    blockquote: "quote",
    link: "link",
    "bullet-list": "list",
    "numbered-list": "listOrdered",
    table: "table",
    figure: "image",
    footnote: "notebookText",
    label: "tag",
    reference: "link",
    bibliography: "bookOpen",
    "math-block": "sigma",
    sqrt: "radical",
    outline: "alignJustify",
    pagebreak: "separatorHorizontal",
    "align-center": "alignCenter",
    "align-right": "alignRight",
    "find-replace": "search",
    "sync-preview": "refresh",
    "export-pdf": "download",
    "toggle-wrap": "wrapText",
    "toggle-special-chars": "pilcrow",
    "toggle-mode": "panelLeft"
  };
  for (const [tool, icon] of Object.entries(toolIcons)) {
    if (icon) replaceSvg(`[data-tool="${tool}"] svg`, icon);
  }

  replaceSvg('.toolbar-dropdown-btn[title="More Text Formatting"] svg', "ellipsis");
  replaceSvg('.toolbar-dropdown-btn[title="Insert Elements"] svg', "plus");
  replaceSvg('.toolbar-dropdown-btn[title="More Math Tools"] svg', "ellipsis");
  replaceSvg('.toolbar-dropdown-btn[title="Layout Options"] svg', "alignRight");
  replaceSvg("#titlebar-minimize svg", "minus", 12);
  replaceSvg("#titlebar-maximize svg", "square", 11);
  replaceSvg("#titlebar-close svg", "x", 12);
  replaceSvg("#preview-menu-btn svg", "ellipsisVertical", 16);
  replaceSvg("#undock-preview-btn svg", "externalLink", 16);
  replaceSvg("#sidebar-toggle-button svg", "panelLeft", 15);
  replaceContents("#settings-close, #log-console-close", "x", 15);
  replaceContents("#editor-tabs-previous", "chevronLeft", 16);
  replaceContents("#editor-tabs-next", "chevronRight", 16);
  replaceContents("#welcome-open-project .welcome-item-icon", "folder", 18);
  replaceContents("#welcome-open-examples .welcome-item-icon", "bookOpen", 18);
  replaceContents("#document-outline-toggle .sidebar-section-chevron", "chevronDown", 14);
  replaceContents("#status-error-icon", "circleX", 13);
  replaceContents("#status-warning-icon", "triangleAlert", 13);
}
