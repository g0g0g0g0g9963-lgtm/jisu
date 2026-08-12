import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const resolveFromRepo = (relativePath: string) =>
  fileURLToPath(new URL(relativePath, import.meta.url));

// Builds `app/page.tsx` as a plain browser-only site, with no Next.js/vinext
// server runtime. `scripts/build-standalone.mjs` then folds the emitted JS,
// CSS and logo into one self-contained page.
export default defineConfig({
  root: resolveFromRepo("standalone"),
  // The logo is inlined by the post-build step instead of being copied.
  publicDir: false,
  css: { postcss: resolveFromRepo(".") },
  plugins: [react()],
  build: {
    outDir: resolveFromRepo("dist-standalone"),
    emptyOutDir: true,
    cssCodeSplit: false,
    rollupOptions: {
      output: {
        // A single JS chunk keeps the inlining step simple.
        inlineDynamicImports: true,
        entryFileNames: "app.js",
        assetFileNames: "app[extname]",
      },
    },
  },
});
