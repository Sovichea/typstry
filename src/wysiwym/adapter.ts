export function splitTypstBlocks(markup: string): string[] {
  const blocks: string[] = [];
  let currentBlock: string[] = [];
  let inTable = false;
  let inCode = false;
  let inQuote = false;
  let inMath = false;

  const flush = () => {
    if (currentBlock.length > 0) {
      blocks.push(currentBlock.join("\n"));
      currentBlock = [];
    }
  };

  for (const line of markup.split("\n")) {
    const trimmed = line.trim();

    if (inCode) {
      currentBlock.push(line);
      if (trimmed.startsWith("```")) {
        inCode = false;
        flush();
      }
    } else if (inTable) {
      currentBlock.push(line);
      if (trimmed.startsWith(")")) {
        inTable = false;
        flush();
      }
    } else if (inQuote) {
      currentBlock.push(line);
      if (trimmed.startsWith("]")) {
        inQuote = false;
        flush();
      }
    } else if (inMath) {
      currentBlock.push(line);
      if (trimmed.startsWith("$")) {
        inMath = false;
        flush();
      }
    } else if (trimmed.startsWith("```")) {
      flush();
      inCode = true;
      currentBlock.push(line);
      if (trimmed.length > 3 && trimmed.endsWith("```")) {
        inCode = false;
        flush();
      }
    } else if (trimmed.startsWith("#table(")) {
      flush();
      inTable = true;
      currentBlock.push(line);
    } else if (trimmed.startsWith("#quote[")) {
      flush();
      inQuote = true;
      currentBlock.push(line);
    } else if (trimmed === "$") {
      flush();
      inMath = true;
      currentBlock.push(line);
    } else if (trimmed.startsWith("=")) {
      flush();
      blocks.push(line);
    } else if (trimmed === "") {
      flush();
    } else {
      currentBlock.push(line);
    }
  }

  flush();
  return blocks;
}

export function renderTypstInlineFormatting(text: string): string {
  let html = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  html = html.replace(/\*([^\*]+)\*/g, '<span class="wysiwym-marker">*</span><span class="wysiwym-bold">$1</span><span class="wysiwym-marker">*</span>');
  html = html.replace(/_([^_]+)_/g, '<span class="wysiwym-marker">_</span><span class="wysiwym-italic">$1</span><span class="wysiwym-marker">_</span>');
  html = html.replace(/#underline\[([^\]]+)\]/g, '<span class="wysiwym-marker">#underline[</span><span class="wysiwym-underline">$1</span><span class="wysiwym-marker">]</span>');
  html = html.replace(/#strike\[([^\]]+)\]/g, '<span class="wysiwym-marker">#strike[</span><span class="wysiwym-strike">$1</span><span class="wysiwym-marker">]</span>');
  html = html.replace(/#highlight\[([^\]]+)\]/g, '<span class="wysiwym-marker">#highlight[</span><span class="wysiwym-highlight">$1</span><span class="wysiwym-marker">]</span>');
  html = html.replace(/`([^`]+)`/g, '<span class="wysiwym-marker">`</span><span class="wysiwym-inline-code">$1</span><span class="wysiwym-marker">`</span>');
  html = html.replace(/#link\("([^"]+)"\)\[([^\]]+)\](?:&lt;([^&]+)&gt;)?/g, (_match, url, content, label) => {
    const labelMarkup = label ? `<span class="wysiwym-marker">&lt;${label}&gt;</span>` : "";
    return `<span class="wysiwym-marker">#link("${url}")[</span><span class="wysiwym-link" data-url="${url}">${content}</span><span class="wysiwym-marker">]</span>${labelMarkup}`;
  });
  html = html.replace(/#footnote\[([^\]]+)\]/g, '<span class="wysiwym-marker">#footnote[</span><span class="wysiwym-footnote">$1</span><span class="wysiwym-marker">]</span>');

  return html;
}

export class WysiwymAdapter {
  constructor(private readonly container: HTMLElement) {}

  render(markup: string): void {
    this.container.innerHTML = "";

    for (const blockText of splitTypstBlocks(markup)) {
      if (!blockText.trim()) continue;

      const block = document.createElement("div");
      const trimmed = blockText.trim();

      if (trimmed.startsWith("=")) {
        block.className = "wysiwym-block heading";
        const match = trimmed.match(/^(=+)/);
        block.dataset.level = match ? match[1].length.toString() : "1";
        block.innerHTML = renderTypstInlineFormatting(trimmed.replace(/^=+\s*/, ""));
        block.contentEditable = "true";
      } else if (trimmed.startsWith("#table(")) {
        this.renderTable(block, trimmed);
      } else if (trimmed.startsWith("#") || trimmed.startsWith("$") || trimmed.startsWith("```") || trimmed.startsWith("<") || trimmed.startsWith("@")) {
        block.className = "wysiwym-block function";
        block.textContent = blockText;
        block.contentEditable = "true";
      } else if (trimmed.startsWith("- ") || trimmed.startsWith("+ ")) {
        block.className = "wysiwym-block list";
        block.innerHTML = renderTypstInlineFormatting(blockText);
        block.contentEditable = "true";
      } else {
        block.className = "wysiwym-block body";
        block.innerHTML = renderTypstInlineFormatting(blockText);
        block.contentEditable = "true";
      }

      this.container.appendChild(block);
    }
  }

  serialize(): string {
    this.container.classList.add("serialize-mode");
    try {
      return Array.from(this.container.querySelectorAll<HTMLElement>(".wysiwym-block"))
        .map(block => this.serializeBlock(block))
        .join("\n\n");
    } finally {
      this.container.classList.remove("serialize-mode");
    }
  }

  private renderTable(block: HTMLDivElement, trimmed: string): void {
    block.className = "wysiwym-block table-block";
    block.contentEditable = "false";

    let innerContent = trimmed.substring(7);
    if (innerContent.endsWith(")")) innerContent = innerContent.slice(0, -1);

    const cells: string[] = [];
    const namedArgs: string[] = [];
    let currentPart = "";
    let bracketDepth = 0;
    let parenthesisDepth = 0;
    let quoteDepth = 0;

    const addPart = (rawPart: string) => {
      const part = rawPart.trim();
      if (!part) return;
      const colonIndex = part.indexOf(":");
      if (colonIndex > 0 && !part.startsWith("[") && !part.startsWith('"')) namedArgs.push(part);
      else cells.push(part);
    };

    for (const character of innerContent) {
      if (character === "[") bracketDepth++;
      else if (character === "]") bracketDepth--;
      else if (character === "(") parenthesisDepth++;
      else if (character === ")") parenthesisDepth--;
      else if (character === '"') quoteDepth = 1 - quoteDepth;

      if (character === "," && bracketDepth === 0 && parenthesisDepth === 0 && quoteDepth === 0) {
        addPart(currentPart);
        currentPart = "";
      } else {
        currentPart += character;
      }
    }
    addPart(currentPart);

    let columnCount = 2;
    const columnArgument = namedArgs.find(argument => argument.startsWith("columns:"));
    if (columnArgument) {
      const value = columnArgument.slice(columnArgument.indexOf(":") + 1).trim();
      if (!Number.isNaN(Number(value))) columnCount = Number(value);
      else if (value.startsWith("(") && value.endsWith(")")) columnCount = value.split(",").length;
    }

    block.dataset.namedArgs = JSON.stringify(namedArgs);
    block.dataset.cols = columnCount.toString();

    const table = document.createElement("table");
    table.className = "wysiwym-table";
    let row = document.createElement("tr");

    cells.forEach((rawCell, index) => {
      let content = rawCell;
      if (content.startsWith("[") && content.endsWith("]")) content = content.slice(1, -1);

      const cell = document.createElement("td");
      cell.contentEditable = "true";
      cell.innerHTML = renderTypstInlineFormatting(content);
      row.appendChild(cell);

      if ((index + 1) % columnCount === 0 || index === cells.length - 1) {
        table.appendChild(row);
        row = document.createElement("tr");
      }
    });

    const header = document.createElement("div");
    header.className = "wysiwym-table-header";
    header.innerText = `Table (${columnCount} columns)`;
    block.append(header, table);
  }

  private serializeBlock(block: HTMLElement): string {
    if (block.classList.contains("heading")) {
      const level = Number.parseInt(block.dataset.level || "1", 10);
      return `${"=".repeat(level)} ${block.innerText || block.textContent || ""}`;
    }

    if (block.classList.contains("table-block")) {
      let markup = "#table(\n";
      let namedArguments: string[] = [];
      try {
        namedArguments = JSON.parse(block.dataset.namedArgs || "[]") as string[];
      } catch {
        namedArguments = [];
      }

      for (const argument of namedArguments) markup += `  ${argument},\n`;

      const cells = Array.from(block.querySelectorAll<HTMLTableCellElement>("td"))
        .map(cell => `[${cell.innerText.trim()}]`);
      const columnCount = Number.parseInt(block.dataset.cols || "2", 10);

      cells.forEach((cell, index) => {
        markup += `  ${cell},`;
        markup += (index + 1) % columnCount === 0 && index !== cells.length - 1 ? "\n" : " ";
      });
      if (!markup.endsWith("\n")) markup += "\n";
      return `${markup})`;
    }

    return block.innerText || block.textContent || "";
  }
}
