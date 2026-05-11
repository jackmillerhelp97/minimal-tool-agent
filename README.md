# @jackmiller/minimal-tool-agent

Small TypeScript helpers for a validated tool-call loop. It is intentionally provider-agnostic: bring any model client that can implement `ModelAdapter`.

## Install

From npm, once published:

```sh
npm install @jackmiller/minimal-tool-agent
```

Directly from a GitHub repo:

```sh
npm install github:jackmillerhelp97/minimal-tool-agent
```

## Usage

```ts
import OpenAI from "openai";
import { z } from "zod";
import {
  createTool,
  runToolLoop,
  type ModelAdapter,
  type ModelMessage
} from "@jackmiller/minimal-tool-agent";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const model: ModelAdapter = {
  async generate({ messages, tools, signal }) {
    const response = await openai.chat.completions.create(
      {
        model: "gpt-4.1-mini",
        messages: messages.map((message) => ({
          role: message.role === "tool" ? "tool" : message.role,
          content: message.content,
          tool_call_id: message.toolCallId,
          tool_calls: message.toolCalls?.map((call) => ({
            id: call.id,
            type: "function",
            function: {
              name: call.name,
              arguments: JSON.stringify(call.args)
            }
          }))
        })),
        tools: tools.map((tool) => ({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            // Convert Zod schemas however you prefer in your app.
            parameters: { type: "object" }
          }
        }))
      },
      { signal }
    );

    const choice = response.choices[0]?.message;
    return {
      content: choice?.content ?? undefined,
      toolCalls: choice?.tool_calls?.map((call) => ({
        id: call.id,
        name: call.function.name,
        args: JSON.parse(call.function.arguments)
      }))
    };
  }
};

const weather = createTool({
  name: "getWeather",
  description: "Gets a short weather summary for a city.",
  inputSchema: z.object({ city: z.string().min(1) }),
  timeoutMs: 5_000,
  maxResultBytes: 2_000,
  async execute({ city }, { signal }) {
    const response = await fetch(`https://wttr.in/${encodeURIComponent(city)}?format=3`, { signal });
    return { summary: await response.text() };
  }
});

const messages: ModelMessage[] = [{ role: "user", content: "Weather in Boston?" }];

const result = await runToolLoop({
  model,
  tools: [weather],
  messages,
  maxSteps: 4,
  toolTimeoutMs: 10_000,
  maxResultBytes: 8_000,
  trace: {
    onToolEnd: ({ toolCall, result }) => console.log(toolCall.name, result)
  }
});

console.log(result.content);
```

## What it includes

- `createTool` with Zod input validation.
- `runToolLoop` with a registry-based tool allowlist.
- Provider-agnostic `ModelAdapter`.
- `maxSteps` loop protection.
- Structured tool errors returned as tool messages.
- Tool and model timeouts with `AbortSignal`.
- Result size limiting.
- Optional trace hooks.

## Development

```sh
npm install
npm test
npm run build
```
