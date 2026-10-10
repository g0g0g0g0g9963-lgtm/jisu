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
  plugins: [react(), {
    name: "kiosk-entry-alias",
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        if (/^\/kiosk\/?(?:\?|$)/.test(req.url || "")) {
          req.url = (req.url || "").replace(/^\/kiosk\/?(?=\?|$)/, "/kiosk.html");
        }
        next();
      });
    },
  }],
  build: {
    outDir: resolveFromRepo("dist"),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolveFromRepo("standalone/index.html"),
        kiosk: resolveFromRepo("standalone/kiosk.html"),
      },
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    // 로컬 개발 시 API는 별도 프로세스(npm run dev:api)로 띄운다.
    proxy: {
      "/api": process.env.API_PROXY_TARGET ?? "http://127.0.0.1:3000",
      "/auth": process.env.API_PROXY_TARGET ?? "http://127.0.0.1:3000",
    },
  },
});
