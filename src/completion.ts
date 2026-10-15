import type { MastraLanguageModel } from "@mastra/core/agent";
import { ModelRouterLanguageModel } from "@mastra/core/llm";

export interface StepObservation {
  stepNumber: number;
  finishReason: string | null;
  providerFinishReason: unknown;
  text: string;
  toolCalls: unknown[];
  sdkUsage: unknown;
  rejectedReason: string | null;
}
type Part = Record<string, unknown>;
type Result = { stream?: ReadableStream<Part>; content?: Part[]; finishReason?: unknown; usage?: unknown };

/** Hold the native response until its finish is known. Mastra can execute tool
 * chunks eagerly, before processOutputStep aborts an unfinished response. */
function finish(value: unknown): string | null {
  if (typeof value === "string") return value;
  // The pinned router exposes v2 but its bundled Anthropic adapter emits v3
  // finish metadata. Keep the original unified/raw pair as evidence.
  return value && typeof value === "object" && "unified" in value && typeof value.unified === "string" ? value.unified : null;
}

export function guardModel(model: MastraLanguageModel | string, observations?: StepObservation[]): MastraLanguageModel {
  const delegate = typeof model === "string"
    ? new ModelRouterLanguageModel(model as ConstructorParameters<typeof ModelRouterLanguageModel>[0]) : model;
  if (!delegate || typeof delegate !== "object" || Reflect.get(delegate, "specificationVersion") !== "v2") throw new Error("coordinator requires the qualified Mastra v2 model adapter");
  let invocation = 0;
  return new Proxy(delegate, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property !== "doGenerate" && property !== "doStream") return typeof value === "function" ? value.bind(target) : value;
      return async (...args: unknown[]) => {
        const observed: StepObservation = { stepNumber: invocation++, finishReason: null, providerFinishReason: null, text: "", toolCalls: [], sdkUsage: null, rejectedReason: null };
        observations?.push(observed);
        let reader: ReadableStreamDefaultReader<Part> | undefined;
        const reject = (reason: string): never => { throw new Error(reason); };
        try {
          const result = await Reflect.apply(value, target, args) as Result;
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
          // Preserve native chunks/metadata, releasing them only after validation.
          return buffered ? { ...result, stream: new ReadableStream<Part>({ start(controller) { for (const part of buffered) controller.enqueue(part); controller.close(); } }) } : result;
        } catch (error) {
          observed.rejectedReason = error instanceof Error ? error.message : String(error);
          if (error instanceof Error) Object.assign(error, { modelObservation: observed });
          throw error;
        } finally {
          if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        }
      };
    },
  }) as MastraLanguageModel;
}
