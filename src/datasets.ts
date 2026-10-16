import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { validateState } from "./workspace.js";
import { sha256 } from "./evidence.js";

function directory() {
  for (const reference of ["../../datasets/manifest.json", "../datasets/manifest.json"]) {
    const file = fileURLToPath(new URL(reference, import.meta.url));
    if (existsSync(file)) return dirname(file);
  }
  throw new Error("Bundled dataset manifest is missing");
}
const definition = z.object({ id: z.string().regex(/^[a-z][a-z-]*$/), profile: z.enum(["starter", "busy", "ambiguous", "boundary"]),
  requestId: z.string().min(1).max(100), allowWrites: z.boolean(), task: z.string().min(1).max(8000), file: z.string().min(1).max(100), sha256: z.string().regex(/^[a-f0-9]{64}$/) });
const schema = z.object({ datasetId: z.literal("synthetic-project-workspace"), version: z.literal(2), provenance: z.string(), cases: z.array(definition).min(1) });
function manifest() {
  const source = readFileSync(resolve(directory(), "manifest.json")), result = schema.parse(JSON.parse(source.toString("utf8")));
  if (new Set(result.cases.map(item => item.id)).size !== result.cases.length || new Set(result.cases.map(item => item.file)).size !== result.cases.length) throw new Error("Duplicate dataset identity/file");
  return { ...result, manifestSha256: sha256(source) };
}
function inspect(id: string, index: ReturnType<typeof manifest>) {
  const selected = index.cases.find(item => item.id === id);
  if (!selected || basename(selected.file) !== selected.file || selected.file.includes("\\")) throw new Error("Unknown dataset case");
  const bytes = readFileSync(resolve(directory(), "cases", selected.file));
  if (sha256(bytes) !== selected.sha256) throw new Error("Dataset file hash mismatch");
  const state = validateState(JSON.parse(bytes.toString("utf8")));
  if (state.dataset?.id !== index.datasetId || state.dataset.version !== index.version || state.dataset.profile !== selected.profile || state.dataset.caseId !== id) throw new Error("Dataset identity mismatch");
  return { selected, bytes, state, manifestSha256: index.manifestSha256 };
}
export function listCases() { const index = manifest(); for (const item of index.cases) inspect(item.id, index); return index; }
export function initializeCase(id: string, destination: string) {
  const loaded = inspect(id, manifest()), file = resolve(destination);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, loaded.bytes, { flag: "wx", mode: 0o600, flush: true });
  return { statePath: file, dataset: loaded.state.dataset, sha256: loaded.selected.sha256, manifestSha256: loaded.manifestSha256,
    task: loaded.selected.task, requestId: loaded.selected.requestId, allowWrites: loaded.selected.allowWrites };
}
