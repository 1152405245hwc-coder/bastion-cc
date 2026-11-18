import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const CHECKED_EXTENSIONS = new Set([".ts", ".mjs", ".js"]);

function walk(dir) {
  const result = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") continue;
    if (entry.isDirectory()) result.push(...walk(path));
    else if (entry.isFile()) {
      for (const ext of CHECKED_EXTENSIONS) {
        if (path.endsWith(ext)) {
          result.push({ path, isTs: ext === ".ts" });
          break;
        }
      }
    }
  }
  return result.sort((left, right) => left.path.localeCompare(right.path));
}

const files = walk(".");
for (const entry of files) {
  const args = entry.isTs ? ["--experimental-strip-types", "--check", entry.path] : ["--check", entry.path];
  execFileSync(process.execPath, args, { stdio: "inherit" });
}
console.log(`RUNTIME_CHECK_OK files=${files.length}`);
