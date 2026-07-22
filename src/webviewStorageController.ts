import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";

type StorageClass = "disposable" | "persistent" | "runtime" | "diagnostics" | "unknown";
type StorageLevel = "healthy" | "advisory" | "actionRecommended" | "critical";

type StorageCategory = {
  name: string;
  class: StorageClass;
  bytes: number;
};

type WebviewStorageReport = {
  supported: boolean;
  platform: string;
  runtime: string;
  profilePath: string;
  appVersion: string;
  scannedAtMs: number | null;
  lastFullScanAtMs: number | null;
  fullScan: boolean;
  estimated: boolean;
  totalBytes: number;
  disposableBytes: number;
  persistentBytes: number;
  runtimeBytes: number;
  diagnosticBytes: number;
  unknownBytes: number;
  freeDiskBytes: number | null;
  growth24hBytes: number | null;
  level: StorageLevel;
  categories: StorageCategory[];
  scanDurationMs: number;
  entriesScanned: number;
  errorCount: number;
  incomplete: boolean;
  sampleCount: number;
};

type DismissedWarning = {
  level: "actionRecommended" | "critical";
  dismissedAt: number;
  thresholdBytes: number;
};

const INITIAL_SCAN_DELAY_MS = 60_000;
const PERIODIC_SCAN_INTERVAL_MS = 30 * 60_000;
const FULL_SCAN_INTERVAL_MS = 24 * 60 * 60_000;
const INPUT_IDLE_MS = 5_000;
const RETRY_DELAY_MS = 5_000;
const WARNING_REPEAT_MS = 7 * 24 * 60 * 60_000;
const ACTION_THRESHOLD_BYTES = 1.5 * 1024 ** 3;
const CRITICAL_THRESHOLD_BYTES = 3 * 1024 ** 3;
const DISMISSED_WARNING_KEY = "typsastra:webview-storage-warning";

export class WebviewStorageController {
  private report: WebviewStorageReport | null = null;
  private scanInProgress = false;
  private lastActivityAt = Date.now();
  private retryTimer: number | null = null;

  constructor(private readonly isBusy: () => boolean = () => false) {}

  public initialize(): void {
    this.bindActivityTracking();
    document.getElementById("settings-storage-scan")?.addEventListener("click", () => {
      void this.requestScan(true, true);
    });
    document.getElementById("settings-storage-reveal")?.addEventListener("click", () => {
      if (this.report?.profilePath) {
        void invoke("reveal_in_explorer", { path: this.report.profilePath });
      }
    });
    document.getElementById("webview-storage-review")?.addEventListener("click", () => {
      document.getElementById("webview-storage-notification")?.classList.add("hidden");
      document.dispatchEvent(new CustomEvent("typsastra:open-settings", { detail: { panel: "storage" } }));
    });
    document.getElementById("webview-storage-dismiss")?.addEventListener("click", () => {
      this.dismissCurrentWarning();
    });
    document.querySelector('[data-settings-panel="storage"]')?.addEventListener("click", () => {
      this.render();
    });

    void this.loadStatus();
    window.setTimeout(() => {
      void this.requestScan(this.needsFullScan(), false);
    }, INITIAL_SCAN_DELAY_MS);
    window.setInterval(() => {
      void this.requestScan(this.needsFullScan(), false);
    }, PERIODIC_SCAN_INTERVAL_MS);
  }

  private bindActivityTracking(): void {
    const markActivity = () => { this.lastActivityAt = Date.now(); };
    document.addEventListener("keydown", markActivity, { capture: true });
    document.addEventListener("input", markActivity, { capture: true });
    document.addEventListener("pointerdown", markActivity, { capture: true });
    document.addEventListener("wheel", markActivity, { capture: true, passive: true });
  }

  private async loadStatus(): Promise<void> {
    try {
      this.report = await invoke<WebviewStorageReport>("get_webview_storage_status");
      this.render();
      await this.refreshWarning();
    } catch (error) {
      this.renderError(`Storage status unavailable: ${String(error)}`);
    }
  }

  private needsFullScan(): boolean {
    if (!this.report?.lastFullScanAtMs) return true;
    return Date.now() - this.report.lastFullScanAtMs >= FULL_SCAN_INTERVAL_MS;
  }

  private async requestScan(full: boolean, manual: boolean): Promise<void> {
    if (this.scanInProgress) return;
    if (!manual && this.report?.supported === false) return;
    if (!manual && !this.canRunBackgroundScan()) {
      this.scheduleRetry(full);
      return;
    }
    this.clearRetry();
    this.scanInProgress = true;
    this.renderScanning();
    try {
      const currentVersion = await getVersion().catch(() => null);
      const versionChanged = Boolean(currentVersion && this.report?.appVersion
        && currentVersion !== this.report.appVersion);
      this.report = await invoke<WebviewStorageReport>("scan_webview_storage", {
        full: full || versionChanged,
      });
      this.render();
      await this.refreshWarning();
      document.dispatchEvent(new CustomEvent("typsastra:webview-storage-updated", {
        detail: this.report,
      }));
    } catch (error) {
      console.warn("WebView storage scan failed.", error);
      this.renderError(`Storage scan failed: ${String(error)}`);
    } finally {
      this.scanInProgress = false;
      this.updateActionState();
    }
  }

  private canRunBackgroundScan(): boolean {
    return document.visibilityState === "visible"
      && Date.now() - this.lastActivityAt >= INPUT_IDLE_MS
      && !this.isBusy();
  }

  private scheduleRetry(full: boolean): void {
    if (this.retryTimer !== null) return;
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      void this.requestScan(full || this.needsFullScan(), false);
    }, RETRY_DELAY_MS);
  }

  private clearRetry(): void {
    if (this.retryTimer === null) return;
    window.clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private render(): void {
    const report = this.report;
    const status = document.getElementById("settings-storage-status");
    const details = document.getElementById("settings-storage-details");
    const categories = document.getElementById("settings-storage-categories");
    const profile = document.getElementById("settings-storage-profile");
    if (!report || !status || !details || !categories || !profile) return;

    status.classList.remove("warning", "error");
    if (!report.supported) {
      status.textContent = `${report.runtime} storage monitoring is not yet qualified on ${report.platform}.`;
      details.textContent = "Windows WebView2 is the first supported monitoring target.";
      profile.textContent = "Profile path unavailable";
      profile.title = "";
      categories.replaceChildren();
      this.updateActionState();
      return;
    }
    if (!report.scannedAtMs) {
      status.textContent = "WebView storage has not been scanned yet.";
      details.textContent = "The first background scan runs after startup, or choose Scan now.";
      profile.textContent = report.profilePath;
      profile.title = report.profilePath;
      categories.replaceChildren();
      this.updateActionState();
      return;
    }

    const levelLabel = storageLevelLabel(report.level);
    status.textContent = `${levelLabel}: ${formatBytes(report.totalBytes)} total, ${formatBytes(report.disposableBytes)} disposable cache.`;
    status.classList.toggle("warning", report.level !== "healthy");
    if (report.incomplete) status.classList.add("warning");
    const scanTime = new Date(report.scannedAtMs).toLocaleString();
    const estimate = report.estimated ? "estimated from the last full scan" : "complete profile scan";
    const growth = report.growth24hBytes === null
      ? "24-hour growth needs more history"
      : `${formatSignedBytes(report.growth24hBytes)} in 24 hours`;
    details.textContent = [
      `${report.runtime} | ${estimate}`,
      `last scan ${scanTime}`,
      growth,
      `${report.entriesScanned.toLocaleString()} entries in ${report.scanDurationMs.toLocaleString()} ms`,
      report.incomplete ? `incomplete (${report.errorCount} errors)` : "",
    ].filter(Boolean).join(" | ");
    profile.textContent = report.profilePath;
    profile.title = report.profilePath;
    categories.replaceChildren(...report.categories.slice(0, 12).map(category => {
      const row = document.createElement("div");
      row.className = "settings-storage-category";
      const name = document.createElement("span");
      name.textContent = category.name;
      name.title = category.name;
      const kind = document.createElement("small");
      kind.textContent = storageClassLabel(category.class);
      const size = document.createElement("strong");
      size.textContent = formatBytes(category.bytes);
      row.append(name, kind, size);
      return row;
    }));
    this.updateSummary("settings-storage-total", report.totalBytes, report.estimated);
    this.updateSummary("settings-storage-disposable", report.disposableBytes, false);
    this.updateSummary("settings-storage-persistent", report.persistentBytes, report.estimated);
    this.updateSummary("settings-storage-free", report.freeDiskBytes, false);
    this.updateActionState();
  }

  private updateSummary(id: string, bytes: number | null, estimated: boolean): void {
    const element = document.getElementById(id);
    if (element) element.textContent = bytes === null ? "Unavailable" : `${estimated ? "~" : ""}${formatBytes(bytes)}`;
  }

  private renderScanning(): void {
    const status = document.getElementById("settings-storage-status");
    if (status) status.textContent = "Scanning WebView storage in the background...";
    this.updateActionState();
  }

  private renderError(message: string): void {
    const status = document.getElementById("settings-storage-status");
    if (!status) return;
    status.classList.add("error");
    status.textContent = message;
  }

  private updateActionState(): void {
    const scan = document.getElementById("settings-storage-scan") as HTMLButtonElement | null;
    const reveal = document.getElementById("settings-storage-reveal") as HTMLButtonElement | null;
    if (scan) {
      scan.disabled = this.scanInProgress || this.report?.supported === false;
      scan.textContent = this.scanInProgress ? "Scanning..." : "Scan now";
    }
    if (reveal) reveal.disabled = !this.report?.profilePath;
  }

  private async refreshWarning(): Promise<void> {
    const report = this.report;
    const badge = document.getElementById("settings-storage-warning");
    badge?.classList.toggle("hidden", !report || report.level === "healthy");
    if (!report || (report.level !== "actionRecommended" && report.level !== "critical")) {
      document.getElementById("webview-storage-notification")?.classList.add("hidden");
      this.resetDismissalAfterRecovery(report);
      return;
    }
    const dismissed = readDismissedWarning();
    const levelIncreased = dismissed && levelRank(report.level) > levelRank(dismissed.level);
    const expired = !dismissed || Date.now() - dismissed.dismissedAt >= WARNING_REPEAT_MS;
    if (!levelIncreased && !expired) return;

    const notification = document.getElementById("webview-storage-notification");
    const title = document.getElementById("webview-storage-notification-title");
    const message = document.getElementById("webview-storage-notification-message");
    if (!notification || !title || !message) return;
    title.textContent = report.level === "critical"
      ? "WebView storage needs attention"
      : "WebView storage is larger than expected";
    message.textContent = `${formatBytes(report.totalBytes)} is in use, including ${formatBytes(report.disposableBytes)} of disposable cache. Review the storage details in Settings.`;
    notification.classList.remove("hidden");
  }

  private dismissCurrentWarning(): void {
    const report = this.report;
    if (!report || (report.level !== "actionRecommended" && report.level !== "critical")) return;
    const thresholdBytes = report.level === "critical" ? CRITICAL_THRESHOLD_BYTES : ACTION_THRESHOLD_BYTES;
    try {
      localStorage.setItem(DISMISSED_WARNING_KEY, JSON.stringify({
        level: report.level,
        dismissedAt: Date.now(),
        thresholdBytes,
      } satisfies DismissedWarning));
    } catch {
      // Restricted WebView storage must not block dismissing the current UI.
    }
    document.getElementById("webview-storage-notification")?.classList.add("hidden");
  }

  private resetDismissalAfterRecovery(report: WebviewStorageReport | null): void {
    const dismissed = readDismissedWarning();
    if (!dismissed || !report) return;
    if (report.totalBytes >= dismissed.thresholdBytes * 0.75) return;
    try {
      localStorage.removeItem(DISMISSED_WARNING_KEY);
    } catch {
      // Restricted WebView storage is non-fatal.
    }
  }
}

function readDismissedWarning(): DismissedWarning | null {
  try {
    const value = JSON.parse(localStorage.getItem(DISMISSED_WARNING_KEY) ?? "null") as Partial<DismissedWarning> | null;
    if (!value || (value.level !== "actionRecommended" && value.level !== "critical")
      || typeof value.dismissedAt !== "number" || typeof value.thresholdBytes !== "number") return null;
    return value as DismissedWarning;
  } catch {
    return null;
  }
}

function levelRank(level: StorageLevel): number {
  return ["healthy", "advisory", "actionRecommended", "critical"].indexOf(level);
}

function storageLevelLabel(level: StorageLevel): string {
  switch (level) {
    case "advisory": return "Storage advisory";
    case "actionRecommended": return "Storage review recommended";
    case "critical": return "Critical storage usage";
    default: return "Storage healthy";
  }
}

function storageClassLabel(value: StorageClass): string {
  switch (value) {
    case "disposable": return "Disposable cache";
    case "persistent": return "Persistent state";
    case "runtime": return "Runtime data";
    case "diagnostics": return "Diagnostics";
    default: return "Unclassified";
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}

function formatSignedBytes(bytes: number): string {
  return `${bytes >= 0 ? "+" : "-"}${formatBytes(Math.abs(bytes))}`;
}
