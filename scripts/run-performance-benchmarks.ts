import { cpus, totalmem, release, type } from "node:os";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Text } from "@codemirror/state";
import { expandSpellcheckRange } from "../src/editor/spellcheck";
import { PERFORMANCE_BUDGETS } from "../src/performance/diagnostics";

const root = process.cwd();
const output = join(root, "artifacts", "performance");
const fixtures = ["01-page", "20-pages-interaction", "30-pages", "100-pages"] as const;
const compileIterations = 5;
const incrementalIterations = 10;

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

async function commandOutput(command: string[]): Promise<string> {
  const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text()
  ]);
  if (exitCode !== 0) {
    throw new Error(`${command.join(" ")} failed: ${stderr.trim()}`);
  }
  return stdout.trim();
}

async function compileFixture(fixture: string): Promise<number> {
  const startedAt = performance.now();
  const child = Bun.spawn([
    "typst", "compile",
    join(root, "benchmarks", "fixtures", `${fixture}.typ`),
    join(output, `${fixture}.pdf`)
  ], { stdout: "ignore", stderr: "inherit" });
  if (await child.exited !== 0) throw new Error(`Typst failed to compile ${fixture}.`);
  return performance.now() - startedAt;
}

function percentile(sorted: number[], fraction: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function summarize(samples: number[]) {
  const sorted = [...samples].sort((left, right) => left - right);
  return {
    samples: samples.map(value => Number(value.toFixed(2))),
    minimumMs: Number(sorted[0].toFixed(2)),
    medianMs: Number(percentile(sorted, 0.5).toFixed(2)),
    p95Ms: Number(percentile(sorted, 0.95).toFixed(2)),
    maximumMs: Number(sorted[sorted.length - 1].toFixed(2))
  };
}

async function directorySize(path: string): Promise<number | null> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    let bytes = 0;
    for (const entry of entries) {
      const child = join(path, entry.name);
      bytes += entry.isDirectory()
        ? (await directorySize(child) ?? 0)
        : (await stat(child)).size;
    }
    return bytes;
  } catch {
    return null;
  }
}

const typstVersion = await commandOutput(["typst", "--version"]);
const tinymistPackage = await Bun.file(join(root, "node_modules", "tinymist", "package.json")).json();
const gitRevision = await commandOutput(["git", "rev-parse", "--short", "HEAD"]);
const gitStatus = await commandOutput(["git", "status", "--porcelain"]);

// This is a first-process measurement, not a true OS cold-cache measurement.
const firstProcessCompileMs = await compileFixture("01-page");

const compile: Record<string, ReturnType<typeof summarize>> = {};
for (const fixture of fixtures) {
  await compileFixture(fixture); // Per-fixture warmup, excluded from the report.
  const samples: number[] = [];
  for (let iteration = 0; iteration < compileIterations; iteration += 1) {
    samples.push(await compileFixture(fixture));
  }
  compile[fixture] = summarize(samples);
}

const paragraph = "Technical writing ភាសាខ្មែរ with mixed scripts and repeatable content.\n";
const largeSource = paragraph.repeat(Math.ceil(100_000 / paragraph.length)).slice(0, 100_000);
await writeFile(join(output, "100000-characters.typ"), largeSource);
const doc = Text.of(largeSource.split("\n"));
let maximumSubmittedRange = 0;
const incrementalSamples: number[] = [];
for (let run = 0; run < incrementalIterations; run += 1) {
  const startedAt = performance.now();
  for (let index = 0; index < 1_000; index += 1) {
    const position = (index * 97) % Math.max(1, doc.length - 1);
    const range = expandSpellcheckRange(doc, position, position + 1, [/[A-Za-z]/u, /[\u1780-\u17ff]/u]);
    maximumSubmittedRange = Math.max(maximumSubmittedRange, range.to - range.from);
  }
  incrementalSamples.push(performance.now() - startedAt);
}

const processor = cpus()[0];
const report = {
  schemaVersion: 2,
  generatedAt: new Date().toISOString(),
  scope: "CLI compiler, incremental-range calculation, and built frontend artifacts; not total desktop runtime",
  source: {
    gitRevision,
    workingTreeDirty: gitStatus.length > 0
  },
  machine: {
    platform: process.platform,
    architecture: process.arch,
    operatingSystem: `${type()} ${release()}`,
    cpu: processor?.model.trim() ?? "unknown",
    logicalCpuCount: cpus().length,
    totalMemoryBytes: totalmem()
  },
  tools: {
    bun: Bun.version,
    typst: typstVersion,
    tinymistPackage: String(tinymistPackage.version)
  },
  budgets: PERFORMANCE_BUDGETS,
  compile: {
    iterationsPerFixture: compileIterations,
    firstProcessOnePageMs: Number(firstProcessCompileMs.toFixed(2)),
    warm: compile
  },
  incrementalSpellcheck: {
    documentUtf16: doc.length,
    editsPerIteration: 1_000,
    iterations: incrementalIterations,
    timing: summarize(incrementalSamples),
    maximumSubmittedUtf16: maximumSubmittedRange
  },
  artifacts: {
    frontendDistBytes: await directorySize(join(root, "dist"))
  },
  limitations: [
    "The first-process compile does not clear operating-system filesystem caches.",
    "Typst CLI process timings are not equivalent to in-app Tinymist preview latency.",
    "Frontend dist size is not installer size.",
    "Desktop, WebView, PDF renderer, GPU, and Tinymist memory are not measured by this harness."
  ]
};

const one = report.compile.warm["01-page"];
const interaction = report.compile.warm["20-pages-interaction"];
const thirty = report.compile.warm["30-pages"];
const hundred = report.compile.warm["100-pages"];
const spellcheck = report.incrementalSpellcheck.timing;
const mib = (bytes: number | null) => bytes === null ? "not built" : `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
const markdown = `# Typsastra benchmark report

Generated: ${report.generatedAt}<br>
Revision: \`${gitRevision}\`${report.source.workingTreeDirty ? " (working tree had uncommitted changes)" : ""}

## Scope

This report measures CLI compiler process time, incremental spellcheck-range calculation, and built frontend artifact size. It does **not** claim to measure total Typsastra desktop memory or end-to-end WebView preview latency.

## Machine and tools

| Item | Value |
|---|---|
| OS | ${report.machine.operatingSystem} (${report.machine.architecture}) |
| CPU | ${report.machine.cpu} (${report.machine.logicalCpuCount} logical CPUs) |
| Installed memory | ${(report.machine.totalMemoryBytes / 1024 / 1024 / 1024).toFixed(2)} GiB |
| Bun | ${report.tools.bun} |
| Typst | ${report.tools.typst} |
| Tinymist npm package | ${report.tools.tinymistPackage} (managed runtime not exercised by this harness) |

## Results

Each warm compiler result contains ${compileIterations} fresh Typst CLI processes after a fixture-specific warmup.

| Workload | Minimum | Median | p95 / maximum |
|---|---:|---:|---:|
| One-page compile | ${one.minimumMs.toFixed(2)} ms | ${one.medianMs.toFixed(2)} ms | ${one.p95Ms.toFixed(2)} ms |
| 20-page multilingual interaction fixture compile | ${interaction.minimumMs.toFixed(2)} ms | ${interaction.medianMs.toFixed(2)} ms | ${interaction.p95Ms.toFixed(2)} ms |
| 30-page compile | ${thirty.minimumMs.toFixed(2)} ms | ${thirty.medianMs.toFixed(2)} ms | ${thirty.p95Ms.toFixed(2)} ms |
| 100-page compile | ${hundred.minimumMs.toFixed(2)} ms | ${hundred.medianMs.toFixed(2)} ms | ${hundred.p95Ms.toFixed(2)} ms |
| 1,000 incremental range calculations | ${spellcheck.minimumMs.toFixed(2)} ms | ${spellcheck.medianMs.toFixed(2)} ms | ${spellcheck.p95Ms.toFixed(2)} ms |

- First-process one-page compile: **${report.compile.firstProcessOnePageMs.toFixed(2)} ms**. This does not clear OS filesystem caches.
- Largest submitted incremental spellcheck range: **${maximumSubmittedRange} UTF-16 units** from a ${doc.length.toLocaleString("en-US")}-unit document.
- Built frontend \`dist/\` size: **${mib(report.artifacts.frontendDistBytes)}**. This is not installer size.

## Limitations

${report.limitations.map(item => `- ${item}`).join("\n")}

## Reproduce

From the repository root, with the recorded Typst and Tinymist tools available:

\`\`\`sh
bun install --frozen-lockfile
bun run build
bun run benchmark:performance
\`\`\`

Raw results are written to \`artifacts/performance/report.json\`.
`;

await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
await writeFile(join(output, "report.md"), markdown);
console.log(markdown);

if (doc.length < 100_000) throw new Error("Large-source fixture is too small.");
if (maximumSubmittedRange >= doc.length) throw new Error("Incremental spellcheck resent the full document.");
