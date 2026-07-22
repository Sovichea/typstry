import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { confirm, message } from "@tauri-apps/plugin-dialog";

export class AppUpdateController {
  private readonly badge = document.getElementById("app-update-badge") as HTMLButtonElement | null;
  private update: Update | null = null;
  private availableVersion: string | null = null;
  private developmentSimulation = false;
  private installing = false;

  constructor(private readonly hasUnsavedChanges: () => boolean = () => false) {}

  public get isInstalling(): boolean {
    return this.installing;
  }

  public initialize(): void {
    if (!this.badge) return;
    this.badge.addEventListener("click", () => void this.confirmAndInstall());

    const simulatedVersion = developmentUpdateVersion();
    if (simulatedVersion) {
      this.developmentSimulation = true;
      this.showAvailableVersion(simulatedVersion);
      return;
    }
    void this.checkSilently();
  }

  private async checkSilently(): Promise<void> {
    try {
      const update = await check({ timeout: 10_000 });
      if (!update) return;
      this.update = update;
      this.showAvailableVersion(update.version);
    } catch (error) {
      // Startup update checks are intentionally silent. Network or endpoint
      // failures must never interrupt opening a local workspace.
      console.debug("Typsastra update check skipped:", error);
    }
  }

  private showAvailableVersion(rawVersion: string): void {
    if (!this.badge) return;
    this.availableVersion = rawVersion;
    const version = displayVersion(rawVersion);
    this.badge.textContent = `Update ${version}`;
    this.badge.title = this.developmentSimulation
      ? `Test Typsastra ${version} update flow (development simulation)`
      : `Typsastra ${version} is available`;
    this.badge.hidden = false;
  }

  private async confirmAndInstall(): Promise<void> {
    if (!this.availableVersion || !this.badge || this.installing) return;

    const unsavedWarning = this.hasUnsavedChanges()
      ? "\n\nYou have unsaved changes. Save them before continuing or they will be lost."
      : "";
    const accepted = await confirm(
      `Typsastra ${displayVersion(this.availableVersion)} is available. Download and install it now?` +
      `\n\nTypsastra will close and reopen after the update.${unsavedWarning}`,
      {
        title: "Update Typsastra",
        kind: "info",
        okLabel: "Download and Install",
        cancelLabel: "Later"
      }
    );
    if (!accepted) return;

    this.installing = true;
    this.badge.disabled = true;
    this.badge.textContent = "Downloading...";

    if (this.developmentSimulation) {
      await this.simulateInstallation();
      return;
    }
    if (!this.update) return;

    let downloaded = 0;
    let contentLength: number | undefined;
    try {
      await this.update.downloadAndInstall(event => {
        if (event.event === "Started") {
          contentLength = event.data.contentLength;
        } else if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
          if (contentLength && contentLength > 0) {
            const percent = Math.min(100, Math.round((downloaded / contentLength) * 100));
            this.badge!.textContent = `Downloading ${percent}%`;
          }
        } else if (event.event === "Finished") {
          this.badge!.textContent = "Installing...";
        }
      });
      await relaunch();
    } catch (error) {
      console.error("Failed to install Typsastra update:", error);
      await message(`The update could not be installed.\n\n${String(error)}`, {
        title: "Update Failed",
        kind: "error"
      });
      this.resetBadge();
    }
  }

  private async simulateInstallation(): Promise<void> {
    for (const percent of [20, 45, 70, 100]) {
      await delay(180);
      this.badge!.textContent = `Downloading ${percent}%`;
    }
    await delay(220);
    this.badge!.textContent = "Installing...";
    await delay(350);
    await message(
      "Development update simulation completed. No installer was downloaded and Typsastra was not restarted.",
      { title: "Update Test Complete", kind: "info" }
    );
    this.resetBadge();
  }

  private resetBadge(): void {
    if (!this.badge || !this.availableVersion) return;
    this.installing = false;
    this.badge.disabled = false;
    this.badge.textContent = `Update ${displayVersion(this.availableVersion)}`;
  }
}

function displayVersion(version: string): string {
  return version.startsWith("v") ? version : `v${version}`;
}

function developmentUpdateVersion(): string | null {
  if (!import.meta.env.DEV) return null;
  const version = new URLSearchParams(window.location.search).get("test-app-update")?.trim();
  return version && /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version) ? version : null;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, milliseconds));
}
