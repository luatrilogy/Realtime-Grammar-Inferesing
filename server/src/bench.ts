#!/usr/bin/env node

import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";
import { performance } from "perf_hooks";

// DATA

function nowCpuSeconds(): number {
  const usage = process.cpuUsage();
  return (usage.user + usage.system) / 1e6;
}

const startWall = performance.now();
const startCpu = nowCpuSeconds();

/**
 * Robust arg parsing: --flag value
 */
function getArg(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}
function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function findProjectRoot(startDir: string): string {
  // Walk upward until we find python/infer_backend.py
  let cur = startDir;
  for (let k = 0; k < 10; k++) {
    const candidate = path.join(cur, "python", "infer_backend.py");
    if (fs.existsSync(candidate)) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  // Fall back to cwd; better than hard-failing
  return process.cwd();
}

function listFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) out.push(p);
    }
  }
  return out;
}

function readCorpusFromDir(
  dir: string,
  opts: { maxFiles: number; maxBytes: number; exts: Set<string> }
): { corpus: string; filesUsed: string[]; bytesRead: number } {
  const all = listFilesRecursive(dir)
    .filter((fp) => opts.exts.has(path.extname(fp).toLowerCase()))
    .sort();

  let bytesRead = 0;
  const filesUsed: string[] = [];
  const chunks: string[] = [];

  for (const fp of all) {
    if (filesUsed.length >= opts.maxFiles) break;
    let buf: Buffer;
    try {
      buf = fs.readFileSync(fp);
    } catch {
      continue;
    }
    if (!buf.length) continue;

    // Enforce maxBytes budget across the whole corpus
    const remaining = opts.maxBytes - bytesRead;
    if (remaining <= 0) break;

    const slice = buf.length > remaining ? buf.subarray(0, remaining) : buf;
    const text = slice.toString("utf8");

    bytesRead += slice.length;
    filesUsed.push(fp);

    // Separator helps avoid accidental token-bridging
    chunks.push(`\n/* FILE: ${path.relative(dir, fp)} */\n`);
    chunks.push(text);
    chunks.push("\n/* END FILE */\n");
  }

  return { corpus: chunks.join(""), filesUsed, bytesRead };
}

const train = getArg("--train");
const out = getArg("--out");
const timeBudget = getArg("--time_budget"); // seconds, optional
const sample = parseInt(getArg("--sample") ?? "200", 10);
const maxMB = parseInt(getArg("--max_mb") ?? "8", 10);
const lang = getArg("--lang") ?? "auto";

const verbose = hasFlag("--verbose");

if (!train || !out) {
  console.error(
    "Usage: node bench.js --train DIR --out FILE [--lang bc|while|auto] [--time_budget SECONDS] [--sample N] [--max_mb MB] [--verbose]"
  );
  process.exit(1);
}

const trainAbs = path.resolve(train);
if (!fs.existsSync(trainAbs) || !fs.statSync(trainAbs).isDirectory()) {
  console.error("Training path is not a directory:", trainAbs);
  process.exit(1);
}

// Extensions to include in the corpus. Add/remove as needed.
const exts = new Set<string>([
  ".ex",
  ".txt",
  ".c",
  ".h",
  ".cpp",
  ".hpp",
  ".py",
  ".js",
  ".ts",
]);

const root = findProjectRoot(process.cwd());
const backendPy = path.join(root, "python", "infer_backend.py");

if (!fs.existsSync(backendPy)) {
  console.error("Cannot find python/infer_backend.py. Searched from:", process.cwd());
  console.error("Expected at:", backendPy);
  process.exit(1);
}

const { corpus, filesUsed, bytesRead } = readCorpusFromDir(trainAbs, {
  maxFiles: Number.isFinite(sample) && sample > 0 ? sample : 200,
  maxBytes: Math.max(1, maxMB) * 1024 * 1024,
  exts,
});

if (verbose) {
  console.log("Project root:", root);
  console.log("Backend:", backendPy);
  console.log("Train dir:", trainAbs);
  console.log("Files used:", filesUsed.length);
  console.log("Bytes read:", bytesRead);
}

if (!corpus.trim()) {
  console.error(
    "No corpus text collected from training directory.\n" +
      "Check that it contains files with one of these extensions:\n" +
      Array.from(exts).join(" ")
  );
  process.exit(1);
}

// Payload expected by infer_backend.py: {"corpus": "..."}
const payload = JSON.stringify({
  lang,
  corpus,
  time_budget: timeBudget ? Number(timeBudget) : undefined,
});

const t0 = Date.now();

// On Windows, "python" is usually fine if Python is installed.
// If you want extra robustness, you can change this to "py" with ["-3", backendPy]
const res = spawnSync("python", [backendPy], {
  input: payload,
  encoding: "utf8",
  maxBuffer: 50 * 1024 * 1024,
});

const wallMs = Date.now() - t0;

if (res.status !== 0) {
  console.error("Inference failed (non-zero exit).");
  if (res.stderr) console.error(res.stderr);
  process.exit(1);
}

// Parse the backend output so we can attach bench metadata (and catch silent errors)
let obj: any;
try {
  obj = JSON.parse(res.stdout);
} catch {
  console.error("Backend did not return valid JSON.");
  console.error("STDOUT:", res.stdout.slice(0, 2000));
  if (res.stderr) console.error("STDERR:", res.stderr.slice(0, 2000));
  process.exit(1);
}

if (obj?.error) {
  console.error("Backend reported error:", obj.error);
  process.exit(1);
}

const endWall = performance.now();
const endCpu = nowCpuSeconds();

obj.power_metrics = {
    wall_seconds: Number(((endWall - startWall) / 1000).toFixed(3)),
    cpu_seconds: Number((endCpu - startCpu).toFixed(3)),
    platform: process.platform,
    node_version: process.version
}

obj.bench = {
  train_dir: trainAbs,
  files_used: filesUsed.length,
  bytes_read: bytesRead,
  wall_ms: wallMs,
  invoked_at: new Date().toISOString(),
};

fs.writeFileSync(out, JSON.stringify(obj, null, 2), "utf8");
console.log("Grammar written to", out);
