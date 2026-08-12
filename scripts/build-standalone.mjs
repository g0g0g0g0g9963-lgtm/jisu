// Folds the Vite standalone build into a single self-contained page that can be
// hosted anywhere (or published as an Artifact) with no server and no external
// requests. Run `pnpm run build:standalone` rather than calling this directly.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const repoUrl = new URL("../", import.meta.url);
const fromRepo = (relativePath) => fileURLToPath(new URL(relativePath, repoUrl));

const BUILD_DIR = "dist-standalone/";
const OUTPUT_PATH = `${BUILD_DIR}bdo-meeting-room.html`;
const PAGE_TITLE = "BDO 회의실 예약";
const LOGO_SOURCE = "public/bdo-logo.png";
// The path `app/page.tsx` requests the logo from; rewritten to an inline asset.
const LOGO_REQUEST_PATH = "/bdo-logo.png";
const LOGO_MEDIA_TYPE = "image/png";

// Prevents an inlined `</script>` or `</style>` from closing its host element.
const escapeForElement = (source, tagName) =>
  source.replaceAll(`</${tagName}`, `<\\/${tagName}`);

const [script, styles, logo] = await Promise.all([
  readFile(fromRepo(`${BUILD_DIR}app.js`), "utf8"),
  readFile(fromRepo(`${BUILD_DIR}app.css`), "utf8"),
  readFile(fromRepo(LOGO_SOURCE)),
]);

const logoDataUri = `data:${LOGO_MEDIA_TYPE};base64,${logo.toString("base64")}`;
const inlinedScript = script.replaceAll(LOGO_REQUEST_PATH, logoDataUri);

if (inlinedScript === script) {
  throw new Error(
    `Expected the bundle to reference ${LOGO_REQUEST_PATH} so it could be inlined.`,
  );
}

// Emitted as a body fragment: the Artifact host supplies the surrounding
// document skeleton, and a plain browser renders the fragment just as well.
const page = `<title>${PAGE_TITLE}</title>
<style>
${escapeForElement(styles, "style")}
</style>
<div id="root"></div>
<script type="module">
${escapeForElement(inlinedScript, "script")}
</script>
`;

await mkdir(fromRepo(BUILD_DIR), { recursive: true });
await writeFile(fromRepo(OUTPUT_PATH), page, "utf8");

const sizeInKb = Math.round(Buffer.byteLength(page) / 1024);
console.log(`Wrote ${OUTPUT_PATH} (${sizeInKb} KB, fully self-contained).`);
