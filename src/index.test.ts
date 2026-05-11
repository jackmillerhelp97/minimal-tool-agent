import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createTool, runToolLoop, type ModelAdapter, type ModelResponse, type ToolCall, type ToolResult } from "./index.js";

function scriptedModel(responses: ModelResponse[]): ModelAdapter {
  let index = 0;
  return {
    async generate() {
      return responses[index++] ?? { content: "done" };
    }
  };
}

function toolCall(name: string, args: unknown): ToolCall {
  return { id: `${name}-1`, name, args };
}

function lastToolResult(messages: Awaited<ReturnType<typeof runToolLoop>>["messages"]): ToolResult {
  const toolMessage = messages.findLast((message) => message.role === "tool");
  if (!toolMessage) {
    throw new Error("missing tool message");
  }
  return JSON.parse(toolMessage.content) as ToolResult;
}

describe("minimal tool agent", () => {
  it("validates inputs and returns successful tool results", async () => {
    const add = createTool({
      name: "add",
      inputSchema: z.object({ a: z.number(), b: z.number() }),
      execute: ({ a, b }) => ({ total: a + b })
    });

    const result = await runToolLoop({
      model: scriptedModel([{ toolCalls: [toolCall("add", { a: 2, b: 3 })] }, { content: "5" }]),
      tools: [add],
      messages: [{ role: "user", content: "add numbers" }]
    });

    expect(result.content).toBe("5");
    expect(lastToolResult(result.messages)).toEqual({ ok: true, result: { total: 5 } });
  });

  it("rejects tools outside the registry allowlist", async () => {
    const result = await runToolLoop({
      model: scriptedModel([{ toolCalls: [toolCall("shell", { command: "rm -rf /" })] }, { content: "blocked" }]),
      tools: [],
      messages: [{ role: "user", content: "run shell" }]
    });

    expect(lastToolResult(result.messages)).toMatchObject({
      ok: false,
      error: { code: "TOOL_NOT_FOUND" }
    });
  });

  it("returns structured validation errors", async () => {
    const echo = createTool({
      name: "echo",
      inputSchema: z.object({ value: z.string() }),
      execute: ({ value }) => value
    });

    const result = await runToolLoop({
      model: scriptedModel([{ toolCalls: [toolCall("echo", { value: 123 })] }, { content: "handled" }]),
      tools: [echo],
      messages: [{ role: "user", content: "echo" }]
    });

    expect(lastToolResult(result.messages)).toMatchObject({
      ok: false,
      error: { code: "VALIDATION_ERROR" }
    });
  });

  it("limits oversized results", async () => {
    const big = createTool({
      name: "big",
      inputSchema: z.object({}),
      execute: () => "too large"
    });

    const result = await runToolLoop({
      model: scriptedModel([{ toolCalls: [toolCall("big", {})] }, { content: "handled" }]),
      tools: [big],
      messages: [{ role: "user", content: "big" }],
      maxResultBytes: 4
    });

    expect(lastToolResult(result.messages)).toMatchObject({
      ok: false,
      error: { code: "RESULT_TOO_LARGE" }
    });
  });

  it("passes abort signals and reports tool timeouts", async () => {
    const slow = createTool({
      name: "slow",
      inputSchema: z.object({}),
      execute: async (_input, { signal }) => {
        await new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }
    });

    const result = await runToolLoop({
      model: scriptedModel([{ toolCalls: [toolCall("slow", {})] }, { content: "handled" }]),
      tools: [slow],
      messages: [{ role: "user", content: "slow" }],
      toolTimeoutMs: 1
    });

    expect(lastToolResult(result.messages)).toMatchObject({
      ok: false,
      error: { code: "TOOL_TIMEOUT" }
    });
  });

  it("emits trace hooks", async () => {
    const events: string[] = [];
    const ping = createTool({
      name: "ping",
      inputSchema: z.object({}),
      execute: () => "pong"
    });

    await runToolLoop({
      model: scriptedModel([{ toolCalls: [toolCall("ping", {})] }, { content: "done" }]),
      tools: [ping],
      messages: [{ role: "user", content: "ping" }],
      trace: {
        onStepStart: ({ step }) => events.push(`step:${step}`),
        onModelResponse: () => events.push("model"),
        onToolStart: () => events.push("tool:start"),
        onToolEnd: () => events.push("tool:end")
      }
    });

    expect(events).toContain("step:1");
    expect(events).toContain("model");
    expect(events).toContain("tool:start");
    expect(events).toContain("tool:end");
  });
});
