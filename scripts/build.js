import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "dist", "chrome");

await rm(outDir, { force: true, recursive: true });
await mkdir(outDir, { recursive: true });

await copyPath("src");
await copyPath("icons");
await copyPath("LICENSE");
await cp(
  path.join(root, "manifest", "chrome.json"),
  path.join(outDir, "manifest.json"),
);

console.log(`Built chrome extension at ${path.relative(root, outDir)}`);

async function copyPath(relativePath) {
  await cp(path.join(root, relativePath), path.join(outDir, relativePath), {
    recursive: true,
  });
}
