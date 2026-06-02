/**
 * Issue #4 repro — AgentOutput.usage capture.
 *
 * SDK AgentOutput at sdk-tools.d.ts:64-75 exposes:
 *   - totalTokens                              (L65)
 *   - totalDurationMs                          (L64)
 *   - usage.input_tokens                       (L67)
 *   - usage.output_tokens                      (L68)
 *   - usage.cache_creation_input_tokens        (L69)
 *   - usage.cache_read_input_tokens            (L70)
 *   - usage.service_tier                       (L75)
 *
 * tool_name = "Task" (the sub-agent dispatcher). When tool_response
 * carries a JSON-stringified AgentOutput with a `usage` block, we emit
 * one `agent_usage` event (category: "cost") with structured data
 * encoding the 7 fields as key:value tokens.
 *
 * The platform side persists these as typed columns post-release; the
 * forward-compatible Zod envelope accepts them today (no migration).
 */

import { describe, test, expect } from "vitest";
import { extractEvents } from "../../src/session/extract.js";

function agentUsageOf(toolResponse: unknown, toolName: string = "Task") {
  return extractEvents({
    tool_name: toolName,
    tool_input: { description: "test" },
    tool_response: typeof toolResponse === "string"
      ? toolResponse
      : JSON.stringify(toolResponse),
  }).filter((e) => e.type === "agent_usage");
}

describe("extractAgentUsage — Issue #4 AgentOutput.usage capture", () => {
  test("tracer: full AgentOutput emits one agent_usage event", () => {
    const events = agentUsageOf({
      totalTokens: 1500,
      totalDurationMs: 4200,
      usage: {
        input_tokens: 800,
        output_tokens: 700,
        cache_creation_input_tokens: 50,
        cache_read_input_tokens: 200,
        service_tier: "standard",
      },
    });
    expect(events.length).toBe(1);
    expect(events[0].category).toBe("cost");
  });

  test("all 7 fields appear in event.data as key:value tokens", () => {
    const events = agentUsageOf({
      totalTokens: 1500,
      totalDurationMs: 4200,
      usage: {
        input_tokens: 800,
        output_tokens: 700,
        cache_creation_input_tokens: 50,
        cache_read_input_tokens: 200,
        service_tier: "standard",
      },
    });
    const data = events[0].data;
    expect(data).toMatch(/totalTokens:1500/);
    expect(data).toMatch(/totalDurMs:4200/);
    expect(data).toMatch(/tokens_in:800/);
    expect(data).toMatch(/tokens_out:700/);
    expect(data).toMatch(/cache_create:50/);
    expect(data).toMatch(/cache_read:200/);
    expect(data).toMatch(/tier:standard/);
  });

  test("partial usage block — missing fields skipped, present fields captured", () => {
    const events = agentUsageOf({
      totalTokens: 100,
      usage: {
        input_tokens: 60,
        output_tokens: 40,
      },
    });
    expect(events.length).toBe(1);
    expect(events[0].data).toMatch(/tokens_in:60/);
    expect(events[0].data).toMatch(/tokens_out:40/);
    expect(events[0].data).not.toMatch(/cache_create:/);
    expect(events[0].data).not.toMatch(/tier:/);
  });

  test("non-Task tools do NOT emit agent_usage", () => {
    const events = agentUsageOf(
      { totalTokens: 100, usage: { input_tokens: 1, output_tokens: 1 } },
      "Bash",
    );
    expect(events.length).toBe(0);
  });

  test("Task tool with non-JSON response emits no event (graceful)", () => {
    const events = agentUsageOf("plain text result not JSON");
    expect(events.length).toBe(0);
  });

  test("Task tool with JSON but no usage block emits no event", () => {
    const events = agentUsageOf({ result: "ok" });
    expect(events.length).toBe(0);
  });

  test("Task tool with empty usage object still emits if totalTokens present", () => {
    const events = agentUsageOf({ totalTokens: 50, usage: {} });
    expect(events.length).toBe(1);
    expect(events[0].data).toMatch(/totalTokens:50/);
  });

  test("event priority is 2 (cost is high-signal but not blocker)", () => {
    const events = agentUsageOf({
      totalTokens: 100,
      usage: { input_tokens: 50, output_tokens: 50 },
    });
    expect(events[0].priority).toBe(2);
  });

  test("service_tier longer than 32 chars is truncated", () => {
    const events = agentUsageOf({
      totalTokens: 100,
      usage: {
        input_tokens: 1, output_tokens: 1,
        service_tier: "X".repeat(200),
      },
    });
    expect(events.length).toBe(1);
    expect(events[0].data.length).toBeLessThan(400);
  });

  test("regression: extractTask (TodoWrite/TaskCreate/TaskUpdate) still works", () => {
    const events = extractEvents({
      tool_name: "TodoWrite",
      tool_input: { todos: [{ content: "x" }] },
      tool_response: "",
    });
    expect(events.some((e) => e.type === "task")).toBe(true);
    expect(events.filter((e) => e.type === "agent_usage").length).toBe(0);
  });
});
