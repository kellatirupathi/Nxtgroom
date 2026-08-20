import { readdir, stat } from "node:fs/promises";
import path from "node:path";

const assetsDir = path.resolve("dist", "assets");
const entries = await readdir(assetsDir);
const javascript = entries.filter((name) => name.endsWith(".js"));
const sizes = await Promise.all(javascript.map(async (name) => ({
  name,
  bytes: (await stat(path.join(assetsDir, name))).size,
})));
const largest = sizes.reduce((current, item) => item.bytes > current.bytes ? item : current, { name: "", bytes: 0 });
const total = sizes.reduce((sum, item) => sum + item.bytes, 0);
const MAX_CHUNK_BYTES = 750 * 1024;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024;

if (largest.bytes > MAX_CHUNK_BYTES || total > MAX_TOTAL_BYTES) {
  throw new Error(
    `Bundle budget exceeded: largest ${largest.name}=${largest.bytes} bytes, total=${total} bytes`
  );
}
console.log(`Bundle budget passed: largest=${largest.bytes} bytes, total=${total} bytes across ${sizes.length} chunks.`);
