import type { MastraLanguageModel } from "@mastra/core/agent";
import { ModelRouterLanguageModel } from "@mastra/core/llm";
import { evidenceLimit, reportedUsage, sha256, type ReportedUsage } from "./evidence.js";

export interface StepObservation {
  stepNumber: number;
  status: "started" | "received" | "accepted" | "rejected";
  startedAt: string;
  finishedAt: string | null;
  promptSha256: string | null;
  providerResponse?: { source: "SDK-decoded-JSON" | "SDK-error-body-text"; id: string | null; model: string | null; requestId: string | null; body: unknown; bodySha256: string; truncated: boolean };
  reportedUsage?: ReportedUsage;
  finishReason: string | null;
  providerFinishReason: unknown;
  text: string;
  toolCalls: unknown[];
  sdkUsage: unknown;
  rejectedReason: string | null;
  sdkError?: { name: string; message: string; statusCode: number | null; requestId: string | null; responseBody: string | null; responseBodyTruncated: boolean };
}
type Part = Record<string, unknown>;
type Result = { stream?: ReadableStream<Part>; content?: Part[]; finishReason?: unknown; usage?: unknown; response?: { id?: string; modelId?: string; headers?: Record<string, string>; body?: unknown } };

/** Hold the native response until its finish is known. Mastra can execute tool
 * chunks eagerly, before processOutputStep aborts an unfinished response. */
function finish(value: unknown): string | null {
  if (typeof value === "string") return value;
  // The pinned router exposes v2 but its bundled Anthropic adapter emits v3
  // finish metadata. Keep the original unified/raw pair as evidence.
  return value && typeof value === "object" && "unified" in value && typeof value.unified === "string" ? value.unified : null;
}

export function guardModel(model: MastraLanguageModel | string, observations?: StepObservation[], onObservation?: (observation: StepObservation) => void): MastraLanguageModel {
  const delegate = typeof model === "string"
    ? new ModelRouterLanguageModel(model as ConstructorParameters<typeof ModelRouterLanguageModel>[0]) : model;
  if (!delegate || typeof delegate !== "object" || Reflect.get(delegate, "specificationVersion") !== "v2") throw new Error("coordinator requires the qualified Mastra v2 model adapter");
  let invocation = 0;
  return new Proxy(delegate, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property !== "doGenerate" && property !== "doStream") return typeof value === "function" ? value.bind(target) : value;
      return async (...args: unknown[]) => {
        const observed: StepObservation = { stepNumber: invocation++, status: "started", startedAt: new Date().toISOString(), finishedAt: null,
          promptSha256: args[0] && typeof args[0] === "object" ? sha256(JSON.stringify(Reflect.get(args[0], "prompt") ?? null)) : null, finishReason: null, providerFinishReason: null, text: "", toolCalls: [], sdkUsage: null, rejectedReason: null };
        observations?.push(observed);
        onObservation?.(observed);
        let reader: ReadableStreamDefaultReader<Part> | undefined;
        const reject = (reason: string): never => { throw new Error(reason); };
        try {
          const result = await Reflect.apply(value, target, args) as Result;
          observed.status = "received";
          if (result.response?.body !== undefined) {
            observed.reportedUsage = reportedUsage(result.response.body);
            const serialized = JSON.stringify(result.response.body), bytes = Buffer.from(serialized);
            observed.providerResponse = { source: "SDK-decoded-JSON", id: result.response.id ?? null, model: result.response.modelId ?? null,
              requestId: result.response.headers?.["request-id"] ?? null, body: bytes.length <= evidenceLimit ? structuredClone(result.response.body) : bytes.subarray(0, evidenceLimit).toString("utf8"), bodySha256: sha256(bytes), truncated: bytes.length > evidenceLimit };
            if (bytes.length > evidenceLimit) reject("provider body exceeds evidence limit");
          }
          onObservation?.(observed);
          let buffered: Part[] | undefined;
          if (result.stream) {
            reader = result.stream.getReader(); buffered = [];
            let bytes = 0, finished = false;
            for (;;) {
              const { value: part, done } = await reader.read();
              if (done) break;
              bytes += Buffer.byteLength(JSON.stringify(part));
              if (bytes > 1_048_576 || buffered.length >= 8192) reject("model response exceeds evidence limit");
              if (finished) reject("model emitted data after its finish");
              buffered.push(part);
              if (part.type === "error") reject("native model stream failed");
              if (part.type === "text-delta" && typeof part.delta === "string") observed.text += part.delta;
              if (part.type === "tool-call") observed.toolCalls.push(structuredClone(part));
              if (part.type === "finish") {
                finished = true; observed.providerFinishReason = structuredClone(part.finishReason ?? null); observed.finishReason = finish(part.finishReason);
                observed.sdkUsage = structuredClone(part.usage ?? null);
              }
            }
            if (!finished) reject("native model stream ended without a finish");
          } else {
            observed.providerFinishReason = structuredClone(result.finishReason ?? null); observed.finishReason = finish(result.finishReason); observed.sdkUsage = structuredClone(result.usage ?? null);
            observed.text = (result.content ?? []).filter(part => part.type === "text" && typeof part.text === "string").map(part => part.text).join("");
            observed.toolCalls = structuredClone((result.content ?? []).filter(part => part.type === "tool-call"));
          }
          if (observed.toolCalls.length) {
            if (observed.finishReason !== "tool-calls") reject("unfinished or inconsistent provider tool response");
            if (observed.toolCalls.length !== 1) reject("parallel tool calls are not supported");
            const id = (observed.toolCalls[0] as Part).toolCallId;
            if (typeof id !== "string" || !id.trim()) reject("invalid tool call ID");
          } else if (observed.finishReason !== "stop" || !observed.text.trim()) reject("provider did not produce a terminal answer");
          observed.status = "accepted"; observed.finishedAt = new Date().toISOString();
          onObservation?.(observed);
          // Preserve native chunks/metadata, releasing them only after validation.
          return buffered ? { ...result, stream: new ReadableStream<Part>({ start(controller) { for (const part of buffered) controller.enqueue(part); controller.close(); } }) } : result;
        } catch (error) {
          observed.status = "rejected"; observed.finishedAt = new Date().toISOString();
          observed.rejectedReason = error instanceof Error ? error.message || error.name : String(error);
          if (error instanceof Error) {
            let source: Error | undefined = error;
            const chain = new Set<Error>();
            let body: unknown, status: unknown, headers: unknown;
            for (let depth = 0; source && depth < 5 && !chain.has(source); depth++) {
              chain.add(source);
              status ??= Reflect.get(source, "statusCode"); headers ??= Reflect.get(source, "responseHeaders");
              body ??= Reflect.get(source, "responseBody") ?? Reflect.get(source, "text");
              const cause: unknown = Reflect.get(source, "cause"); source = cause instanceof Error ? cause : undefined;
            }
            const bytes = typeof body === "string" ? Buffer.from(body) : null;
            const requestId = headers && typeof headers === "object" && typeof Reflect.get(headers, "request-id") === "string" ? Reflect.get(headers, "request-id") as string : null;
            observed.sdkError = { name: error.name, message: error.message, statusCode: typeof status === "number" ? status : null,
              requestId, responseBody: bytes ? bytes.subarray(0, evidenceLimit).toString("utf8") : null, responseBodyTruncated: (bytes?.length ?? 0) > evidenceLimit };
            if (bytes) {
              let bodyValue: unknown = bytes.subarray(0, evidenceLimit).toString("utf8");
              if (bytes.length <= evidenceLimit) { try { bodyValue = JSON.parse(body as string); } catch { /* Keep SDK body text when JSON is invalid. */ } }
              observed.providerResponse ??= { source: "SDK-error-body-text", id: null, model: null, requestId, body: bodyValue, bodySha256: sha256(bytes), truncated: bytes.length > evidenceLimit };
              if (bytes.length <= evidenceLimit && typeof bodyValue === "object") observed.reportedUsage ??= reportedUsage(bodyValue);
            }
            Object.assign(error, { modelObservation: observed });
          }
          onObservation?.(observed);
          throw error;
        } finally {
          if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        }
      };
    },
  }) as MastraLanguageModel;
}
