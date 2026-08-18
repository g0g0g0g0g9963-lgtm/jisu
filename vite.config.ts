import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const resolveFromRepo = (relativePath: string) =>
  fileURLToPath(new URL(relativePath, import.meta.url));

// 원본의 vite.standalone.config.ts와 같은 방식으로 app/page.tsx를 브라우저
// 전용으로 빌드한다. 결과(dist/)는 런타임에 server/index.mjs가 서비스한다.
export default defineConfig({
  root: resolveFromRepo("standalone"),
  publicDir: resolveFromRepo("public"),
  css: { postcss: resolveFromRepo(".") },
  plugins: [react()],
  build: {
    outDir: resolveFromRepo("dist"),
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    // 로컬 개발 시 API는 별도 프로세스(npm run dev:api)로 띄운다.
    proxy: {
      "/api": "http://127.0.0.1:3000",
    },
  },
});
