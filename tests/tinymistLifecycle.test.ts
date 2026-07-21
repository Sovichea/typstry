import { describe, expect, test } from "bun:test";

describe("Tinymist workspace lifecycle", () => {
  test("exposes an explicit native process stop boundary", async () => {
    const nativeSource = await Bun.file(new URL("../src-tauri/src/lib.rs", import.meta.url)).text();
    const transportSource = await Bun.file(new URL("../src/compiler/lspTransport.ts", import.meta.url)).text();
    const clientSource = await Bun.file(new URL("../src/compiler/lsp.ts", import.meta.url)).text();

    expect(nativeSource).toContain("async fn stop_tinymist_lsp");
    expect(nativeSource).toContain("stop_lsp_process(&state).await");
    expect(transportSource).toContain('invoke("stop_tinymist_lsp")');
    expect(clientSource).toContain("public async stop(): Promise<void>");
  });

  test("restarts for main-file changes and stops when a project closes", async () => {
    const source = await Bun.file(new URL("../src/appController.ts", import.meta.url)).text();

    expect(source).toContain("mainChanged && this.lspClient");
    expect(source).toContain("preparePinnedMainTypography(path)");
    expect(source).toContain("scaled_workspace_font_set_status");
    expect(source).toContain("activate_scaled_workspace_fonts");
    expect(source).toContain("synchronizeDocumentTypography(typography)");
    expect(source).toContain("ownsWorkspaceTypography && !await this.confirmTypographyScaleRange(config)");
    expect(source).toContain("if (!this.isPinnedMainFile(filePath))");
    expect(source.indexOf("preparePinnedMainTypography(path)")).toBeLessThan(
      source.indexOf("this.pinnedMainFilePath = path", source.indexOf("preparePinnedMainTypography(path)"))
    );
    expect(source).toContain('restartTinymistSession("Restarting Tinymist for the new main file..."');
    expect(source).toContain('stopTinymistSession("Project closed")');
    expect(source).toContain("tinymistLifecycleQueue");
  });
});
