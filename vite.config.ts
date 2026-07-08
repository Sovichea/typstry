import { defineConfig } from "vite";

export default defineConfig({
  clearScreen: false,
  server: {
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
  },
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    target: process.env.TAURI_PLATFORM == 'windows' ? 'chrome105' : 'safari13',
    minify: !process.env.TAURI_DEBUG ? 'esbuild' : false,
    sourcemap: !!process.env.TAURI_DEBUG,
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (id.includes("node_modules/@uiw/codemirror-themes")) return "editor-themes";
          if (id.includes("node_modules/@codemirror") || id.includes("node_modules/@lezer")) return "editor-engine";
          if (id.includes("node_modules/@tauri-apps")) return "tauri-runtime";
        }
      }
    }
  },
});
