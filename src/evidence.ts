import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { validateState } from "./workspace.js";

export const evidenceLimit = 1_048_576;
export const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
export type UsageField = "input_tokens" | "output_tokens" | "cache_creation_input_tokens" | "cache_read_input_tokens";
const usageFields: UsageField[] = ["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"];
export interface ReportedUsage {
  source: "SDK-exposed-provider-body";
  available: boolean;
  raw: unknown;
  fields: Record<UsageField, number | null>;
  status: "unknown" | "partial" | "reported";
  totals: { inputTokens: number; outputTokens: number; totalTokens: number } | null;
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
export function reportedUsage(body: unknown): ReportedUsage {
  const available = object(body) && Object.hasOwn(body, "usage"), raw = available ? body.usage : null;
  const fields = Object.fromEntries(usageFields.map(key => [key, object(raw) && Number.isSafeInteger(raw[key]) && Number(raw[key]) >= 0 ? raw[key] : null])) as Record<UsageField, number | null>;
  const complete = usageFields.every(key => fields[key] !== null);
  const input = complete ? fields.input_tokens! + fields.cache_creation_input_tokens! + fields.cache_read_input_tokens! : null;
  const total = input !== null ? input + fields.output_tokens! : null;
  const totals = input !== null && Number.isSafeInteger(input) && Number.isSafeInteger(total) ? { inputTokens: input, outputTokens: fields.output_tokens!, totalTokens: total! } : null;
  return { source: "SDK-exposed-provider-body", available, raw, fields, status: totals ? "reported" : Object.values(fields).some(value => value !== null) ? "partial" : "unknown", totals };
}
export function aggregateUsage(steps: { reportedUsage?: ReportedUsage }[]) {
  const fields = Object.fromEntries(usageFields.map(key => {
    const values = steps.map(step => step.reportedUsage?.fields[key]);
    const sum = values.reduce<number>((n, value) => n + (value ?? 0), 0);
    return [key, values.length && values.every(value => value !== null && value !== undefined) && Number.isSafeInteger(sum) ? sum : null];
  })) as Record<UsageField, number | null>;
  const complete = steps.length > 0 && steps.every(step => step.reportedUsage?.status === "reported");
  const input = complete ? fields.input_tokens! + fields.cache_creation_input_tokens! + fields.cache_read_input_tokens! : null;
  const total = input !== null ? input + fields.output_tokens! : null;
  const totals = input !== null && usageFields.every(key => fields[key] !== null) && Number.isSafeInteger(input) && Number.isSafeInteger(total) ? { inputTokens: input, outputTokens: fields.output_tokens!, totalTokens: total! } : null;
  return { status: totals ? "reported" : Object.values(fields).some(value => value !== null) ? "partial" : "unknown", fields, totals,
    attempts: steps.length, measuredAttempts: steps.filter(step => step.reportedUsage?.status === "reported").length, cost: { status: "unknown", amount: null } };
}
export function stateSnapshot(file: string) {
  try {
    const bytes = readFileSync(file), hash = sha256(bytes);
    try {
      const state = validateState(JSON.parse(bytes.toString("utf8")));
      return { path: resolve(file), fileSha256: hash, dataset: state.dataset ?? null,
        counts: { issues: state.issues.length, posts: state.posts.length, audit: state.audit.length, requests: state.requests?.length ?? 0 }, error: null };
    } catch (error) { return { path: resolve(file), fileSha256: hash, dataset: null, counts: null, error: error instanceof Error ? error.message : String(error) }; }
  } catch (error) { return { path: resolve(file), fileSha256: null, dataset: null, counts: null, error: error instanceof Error ? error.message : String(error) }; }
}
export function receiptFile(outputRoot: string) {
  const runId = randomUUID(), directory = resolve(outputRoot, runId);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return { runId, path: join(directory, "receipt.json") };
}
export function persistReceipt(file: string, value: unknown) {
  const staging = `${file}.${randomUUID()}.tmp`;
  try { writeFileSync(staging, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600, flush: true }); renameSync(staging, file); }
  finally { rmSync(staging, { force: true }); }
}
