import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const targets = new Set(["chrome", "firefox"]);
const target = process.argv[2];

if (!targets.has(target)) {
  console.error("Usage: node scripts/build.js <chrome|firefox>");
  process.exit(1);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "dist", target);

await rm(outDir, { force: true, recursive: true });
await mkdir(outDir, { recursive: true });

await copyPath("src");
await copyPath("icons");
await copyPath("LICENSE");
await cp(
  path.join(root, "manifest", `${target}.json`),
  path.join(outDir, "manifest.json"),
);

console.log(`Built ${target} extension at ${path.relative(root, outDir)}`);

async function copyPath(relativePath) {
  await cp(path.join(root, relativePath), path.join(outDir, relativePath), {
    recursive: true,
  });
}
