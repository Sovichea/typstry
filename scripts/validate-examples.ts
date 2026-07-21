import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";

function findMainFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return findMainFiles(path);
    return entry.isFile() && entry.name === "main.typ" ? [path] : [];
  });
}

function findTypFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return findTypFiles(path);
    return entry.isFile() && entry.name.endsWith(".typ") ? [path] : [];
  });
}

const root = resolve(import.meta.dir, "../src-tauri/resources/examples");
const typst = process.env.TYPSASTRA_TYPST_BIN || Bun.which("typst");
if (!typst) {
  console.error("Typst was not found. Install it or set TYPSASTRA_TYPST_BIN.");
  process.exit(1);
}

const outputDirectory = mkdtempSync(join(tmpdir(), "typsastra-examples-"));
const failures: string[] = [];

try {
  const mainFiles = findMainFiles(root).sort();
  for (const source of mainFiles) {
    const contents = readFileSync(source, "utf8");
    if (!contents.includes("typsastra:document-scripts")) {
      failures.push(`${relative(root, source).replaceAll("\\", "/")}\nMissing current typsastra:document-scripts metadata.`);
    }
  }
  for (const source of findTypFiles(root)) {
    const contents = readFileSync(source, "utf8");
    const managedBlocks = contents.match(/typsastra:typography:start[\s\S]*?typsastra:typography:end/g) ?? [];
    if (managedBlocks.some(block => /\bset text\s*\(/.test(block) && !block.includes("scx="))) {
      failures.push(`${relative(root, source).replaceAll("\\", "/")}\nManaged typography still uses a legacy unrestricted font stack.`);
    }
  }
  for (const source of mainFiles) {
    const relativePath = relative(root, source).replaceAll("\\", "/");
    const outputName = relativePath.replaceAll("/", "__").replace(/\.typ$/, ".pdf");
    const process = Bun.spawnSync([typst, "compile", source, join(outputDirectory, outputName)], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (process.exitCode !== 0) {
      const diagnostics = new TextDecoder().decode(process.stderr).trim();
      failures.push(`${relativePath}\n${diagnostics}`);
    }
  }

  if (failures.length > 0) {
    console.error(`Failed to compile ${failures.length} bundled example(s):\n\n${failures.join("\n\n")}`);
    process.exitCode = 1;
  } else {
    console.log(`Compiled ${mainFiles.length} bundled main.typ files successfully.`);
  }
} finally {
  rmSync(outputDirectory, { recursive: true, force: true });
}
