import { z, type ZodTypeAny } from "zod";

export type ToolErrorCode =
  | "TOOL_NOT_FOUND"
  | "VALIDATION_ERROR"
  | "TOOL_TIMEOUT"
  | "TOOL_EXECUTION_ERROR"
  | "RESULT_TOO_LARGE"
  | "ABORTED";

export interface ToolError {
  code: ToolErrorCode;
  message: string;
  details?: unknown;
}

export type ToolResult =
  | { ok: true; result: unknown }
  | { ok: false; error: ToolError };

export interface ToolContext {
  signal: AbortSignal;
  toolCallId: string;
}

export interface ToolDefinition<Input = unknown, Output = unknown> {
  name: string;
  description?: string;
  inputSchema: ZodTypeAny;
  timeoutMs?: number;
  maxResultBytes?: number;
  execute: (input: Input, context: ToolContext) => Promise<Output> | Output;
}

export type Tool<Input = unknown, Output = unknown> = ToolDefinition<Input, Output>;
export type AnyTool = ToolDefinition<any, unknown>;

export interface ToolSpec {
  name: string;
  description?: string;
  inputSchema: ZodTypeAny;
}

export interface ModelMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  toolName?: string;
  toolCalls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  name: string;
  args: unknown;
}

export interface ModelRequest {
  messages: ModelMessage[];
  tools: ToolSpec[];
  signal: AbortSignal;
  step: number;
}

export interface ModelResponse {
  content?: string;
  toolCalls?: ToolCall[];
}

export interface ModelAdapter {
  generate(request: ModelRequest): Promise<ModelResponse>;
}

export interface TraceHooks {
  onStepStart?: (event: { step: number; messages: ModelMessage[] }) => void | Promise<void>;
  onModelResponse?: (event: { step: number; response: ModelResponse }) => void | Promise<void>;
  onToolStart?: (event: { step: number; toolCall: ToolCall }) => void | Promise<void>;
  onToolEnd?: (event: { step: number; toolCall: ToolCall; result: ToolResult }) => void | Promise<void>;
  onStepEnd?: (event: { step: number; messages: ModelMessage[] }) => void | Promise<void>;
}

export interface RunToolLoopOptions {
  model: ModelAdapter;
  tools: AnyTool[];
  messages: ModelMessage[];
  maxSteps?: number;
  signal?: AbortSignal;
  modelTimeoutMs?: number;
  toolTimeoutMs?: number;
  maxResultBytes?: number;
  trace?: TraceHooks;
}

export interface RunToolLoopResult {
  content: string;
  messages: ModelMessage[];
  steps: number;
  stoppedBy: "final" | "maxSteps";
}

export function createTool<const Schema extends ZodTypeAny, Output>(definition: {
  name: string;
  description?: string;
  inputSchema: Schema;
  timeoutMs?: number;
  maxResultBytes?: number;
  execute: (input: z.infer<Schema>, context: ToolContext) => Promise<Output> | Output;
}): Tool<z.infer<Schema>, Output> {
  return definition;
}

export async function runToolLoop(options: RunToolLoopOptions): Promise<RunToolLoopResult> {
  const maxSteps = options.maxSteps ?? 8;
  const registry = new Map(options.tools.map((tool) => [tool.name, tool]));
  const messages = [...options.messages];
  const baseController = childController(options.signal);
  let lastContent = "";

  try {
    for (let step = 1; step <= maxSteps; step += 1) {
      throwIfAborted(baseController.signal);
      await options.trace?.onStepStart?.({ step, messages: [...messages] });

      const modelSignal = withTimeout(baseController.signal, options.modelTimeoutMs);
      const response = await options.model.generate({
        messages: [...messages],
        tools: options.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
        signal: modelSignal.signal,
        step
      });
      modelSignal.cleanup();

      await options.trace?.onModelResponse?.({ step, response });

      if (response.content) {
        lastContent = response.content;
      }

      if (response.content || response.toolCalls?.length) {
        messages.push({
          role: "assistant",
          content: response.content ?? "",
          toolCalls: response.toolCalls
        });
      }

      if (!response.toolCalls?.length) {
        await options.trace?.onStepEnd?.({ step, messages: [...messages] });
        return { content: lastContent, messages, steps: step, stoppedBy: "final" };
      }

      for (const toolCall of response.toolCalls) {
        await options.trace?.onToolStart?.({ step, toolCall });
        const result = await runToolCall(toolCall, registry, baseController.signal, {
          defaultTimeoutMs: options.toolTimeoutMs,
          defaultMaxResultBytes: options.maxResultBytes
        });
        messages.push({
          role: "tool",
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          content: JSON.stringify(result)
        });
        await options.trace?.onToolEnd?.({ step, toolCall, result });
      }

      await options.trace?.onStepEnd?.({ step, messages: [...messages] });
    }
  } finally {
    baseController.cleanup();
  }

  return { content: lastContent, messages, steps: maxSteps, stoppedBy: "maxSteps" };
}

async function runToolCall(
  toolCall: ToolCall,
  registry: Map<string, AnyTool>,
  parentSignal: AbortSignal,
  defaults: { defaultTimeoutMs?: number; defaultMaxResultBytes?: number }
): Promise<ToolResult> {
  const tool = registry.get(toolCall.name);
  if (!tool) {
    return fail("TOOL_NOT_FOUND", `Tool "${toolCall.name}" is not registered.`);
  }

  const parsed = tool.inputSchema.safeParse(toolCall.args);
  if (!parsed.success) {
    return fail("VALIDATION_ERROR", `Invalid input for tool "${toolCall.name}".`, parsed.error.flatten());
  }

  const timeoutMs = tool.timeoutMs ?? defaults.defaultTimeoutMs;
  const maxResultBytes = tool.maxResultBytes ?? defaults.defaultMaxResultBytes;
  const controller = withTimeout(parentSignal, timeoutMs);

  try {
    const result = await tool.execute(parsed.data, {
      signal: controller.signal,
      toolCallId: toolCall.id
    });
    if (maxResultBytes !== undefined && byteLength(JSON.stringify(result)) > maxResultBytes) {
      return fail("RESULT_TOO_LARGE", `Result from tool "${toolCall.name}" exceeded ${maxResultBytes} bytes.`);
    }
    return { ok: true, result };
  } catch (error) {
    if (controller.signal.aborted) {
      return fail(controller.timedOut ? "TOOL_TIMEOUT" : "ABORTED", controller.timedOut ? `Tool "${toolCall.name}" timed out.` : "Tool call aborted.");
    }
    return fail("TOOL_EXECUTION_ERROR", error instanceof Error ? error.message : String(error));
  } finally {
    controller.cleanup();
  }
}

function fail(code: ToolErrorCode, message: string, details?: unknown): ToolResult {
  return { ok: false, error: { code, message, details } };
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function childController(parent?: AbortSignal): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  if (!parent) {
    return { signal: controller.signal, cleanup: () => undefined };
  }
  if (parent.aborted) {
    controller.abort(parent.reason);
    return { signal: controller.signal, cleanup: () => undefined };
  }
  const abort = () => controller.abort(parent.reason);
  parent.addEventListener("abort", abort, { once: true });
  return {
    signal: controller.signal,
    cleanup: () => parent.removeEventListener("abort", abort)
  };
}

function withTimeout(parent: AbortSignal, timeoutMs?: number): { signal: AbortSignal; timedOut: boolean; cleanup: () => void } {
  const controller = new AbortController();
  let timedOut = false;

  if (parent.aborted) {
    controller.abort(parent.reason);
  }

  const abortFromParent = () => controller.abort(parent.reason);
  parent.addEventListener("abort", abortFromParent, { once: true });

  const timer =
    timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          controller.abort(new Error(`Timed out after ${timeoutMs}ms`));
        }, timeoutMs);

  return {
    signal: controller.signal,
    get timedOut() {
      return timedOut;
    },
    cleanup: () => {
      parent.removeEventListener("abort", abortFromParent);
      if (timer) {
        clearTimeout(timer);
      }
    }
  };
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("Aborted");
  }
}
