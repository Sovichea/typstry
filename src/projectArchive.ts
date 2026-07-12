export const TYPSTRY_PROJECT_FORMAT = "com.typstry.project" as const;
export const TYPSTRY_PROJECT_SCHEMA_VERSION = 1 as const;
export const TYPSTRY_PROJECT_EXTENSION = "typstry" as const;

export type TypstryProjectManifest = {
  format: typeof TYPSTRY_PROJECT_FORMAT;
  schemaVersion: typeof TYPSTRY_PROJECT_SCHEMA_VERSION;
  createdBy: {
    application: "Typstry";
    version: string;
  };
  project: {
    name: string;
    main: string;
  };
  toolchain: {
    typstVersion: string;
    tinymistVersion: string;
    compatibility: "exact";
  };
  renderEnvironment: {
    fontsPackaged: boolean;
  };
  fonts: TypstryProjectFont[];
  integrity: {
    algorithm: "sha256";
    files: Record<string, string>;
  };
};

export type TypstryProjectFont = {
  id: string;
  family: string;
  postscriptName: string;
  style: string;
  weight: number;
  stretch: number;
  path: string;
  sha256: string;
  license: {
    name: string;
    redistributable: boolean;
  };
};

export type ProjectToolchainState = "exact-active" | "exact-installed" | "download-required";

export type TypstryProjectPreflight = {
  manifest: TypstryProjectManifest;
  manifestSha256: string;
  entryCount: number;
  totalUncompressedBytes: number;
  suggestedFolderName: string;
  toolchainState: ProjectToolchainState;
  activeTypstVersion: string | null;
  activeTinymistVersion: string | null;
};

export type ImportedTypstryProject = {
  workspacePath: string;
  mainFilePath: string;
  manifest: TypstryProjectManifest;
};

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

function validArchivePath(value: unknown, label: string): string {
  const path = stringValue(value, label);
  if (
    path.startsWith("/") ||
    path.startsWith("\\") ||
    path.includes("\\") ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`${label} is not a safe relative archive path.`);
  }
  return path;
}

function sha256Value(value: unknown, label: string): string {
  const digest = stringValue(value, label).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(digest)) {
    throw new Error(`${label} must be a SHA-256 digest.`);
  }
  return digest;
}

function semanticVersion(value: unknown, label: string): string {
  const version = stringValue(value, label);
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`${label} must be a semantic version.`);
  }
  return version;
}

function parseFont(value: unknown, index: number): TypstryProjectFont {
  const font = objectValue(value, `fonts[${index}]`);
  const license = objectValue(font.license, `fonts[${index}].license`);
  const weight = font.weight;
  const stretch = font.stretch;
  if (!Number.isInteger(weight) || (weight as number) < 1 || (weight as number) > 1000) {
    throw new Error(`fonts[${index}].weight is invalid.`);
  }
  if (!Number.isInteger(stretch) || (stretch as number) < 1 || (stretch as number) > 1000) {
    throw new Error(`fonts[${index}].stretch is invalid.`);
  }
  if (typeof license.redistributable !== "boolean") {
    throw new Error(`fonts[${index}].license.redistributable must be a boolean.`);
  }
  return {
    id: stringValue(font.id, `fonts[${index}].id`),
    family: stringValue(font.family, `fonts[${index}].family`),
    postscriptName: stringValue(font.postscriptName, `fonts[${index}].postscriptName`),
    style: stringValue(font.style, `fonts[${index}].style`),
    weight: weight as number,
    stretch: stretch as number,
    path: validArchivePath(font.path, `fonts[${index}].path`),
    sha256: sha256Value(font.sha256, `fonts[${index}].sha256`),
    license: {
      name: stringValue(license.name, `fonts[${index}].license.name`),
      redistributable: license.redistributable
    }
  };
}

export function parseTypstryProjectManifest(value: unknown): TypstryProjectManifest {
  const root = objectValue(value, "project manifest");
  if (root.format !== TYPSTRY_PROJECT_FORMAT) {
    throw new Error(`Unsupported project format '${String(root.format)}'.`);
  }
  if (root.schemaVersion !== TYPSTRY_PROJECT_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported Typstry project schema version '${String(root.schemaVersion)}'. ` +
      `This build supports version ${TYPSTRY_PROJECT_SCHEMA_VERSION}.`
    );
  }
  const createdBy = objectValue(root.createdBy, "createdBy");
  const project = objectValue(root.project, "project");
  const toolchain = objectValue(root.toolchain, "toolchain");
  const renderEnvironment = objectValue(root.renderEnvironment, "renderEnvironment");
  const integrity = objectValue(root.integrity, "integrity");
  const files = objectValue(integrity.files, "integrity.files");
  const main = validArchivePath(project.main, "project.main");
  if (createdBy.application !== "Typstry") {
    throw new Error(`Unsupported project creator '${String(createdBy.application)}'.`);
  }
  if (!main.endsWith(".typ")) throw new Error("project.main must be a .typ file.");
  if (toolchain.compatibility !== "exact") {
    throw new Error(`Unsupported toolchain compatibility '${String(toolchain.compatibility)}'.`);
  }
  if (integrity.algorithm !== "sha256") {
    throw new Error(`Unsupported integrity algorithm '${String(integrity.algorithm)}'.`);
  }
  if (typeof renderEnvironment.fontsPackaged !== "boolean") {
    throw new Error("renderEnvironment.fontsPackaged must be a boolean.");
  }
  const parsedFiles = Object.fromEntries(
    Object.entries(files).map(([path, digest]) => [
      validArchivePath(path, "integrity file path"),
      sha256Value(digest, `integrity.files['${path}']`)
    ])
  );
  if (!(main in parsedFiles)) {
    throw new Error("project.main is missing from integrity.files.");
  }
  if (!Array.isArray(root.fonts)) throw new Error("fonts must be an array.");
  return {
    format: TYPSTRY_PROJECT_FORMAT,
    schemaVersion: TYPSTRY_PROJECT_SCHEMA_VERSION,
    createdBy: {
      application: "Typstry",
      version: stringValue(createdBy.version, "createdBy.version")
    },
    project: {
      name: stringValue(project.name, "project.name"),
      main
    },
    toolchain: {
      typstVersion: semanticVersion(toolchain.typstVersion, "toolchain.typstVersion"),
      tinymistVersion: semanticVersion(toolchain.tinymistVersion, "toolchain.tinymistVersion"),
      compatibility: "exact"
    },
    renderEnvironment: { fontsPackaged: renderEnvironment.fontsPackaged },
    fonts: root.fonts.map(parseFont),
    integrity: { algorithm: "sha256", files: parsedFiles }
  };
}
