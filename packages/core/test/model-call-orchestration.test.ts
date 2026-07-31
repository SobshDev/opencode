import { describe, expect, test } from "bun:test"
import { ModelCallOrchestration } from "@opencode-ai/core/model-call/orchestration"
import { ModelCall } from "@opencode-ai/schema/model-call"

const statuses = [
  "preparing",
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
] as const satisfies ReadonlyArray<ModelCall.Status>
const terminal = new Set<ModelCall.Status>(["completed", "failed", "cancelled", "interrupted"])
const prompts = ["missing", "admitted", "promoted"] as const
const assistants = ["none", "incomplete", "continuation", "terminal"] as const

describe("ModelCallOrchestration recovery contract", () => {
  const adapters = [
    { name: "current", continuationFinishes: ["tool-calls", "unknown"] },
    { name: "v2", continuationFinishes: ["tool-calls"] },
  ] as const
  const lifecycleVectors = [
    {
      name: "unstarted admitted prompt",
      prompt: { exists: true, promoted: false },
      assistant: { exists: false, completed: false, error: false },
      expected: { action: "resume" },
    },
    {
      name: "incomplete provider turn",
      prompt: { exists: true, promoted: true },
      assistant: { exists: true, completed: false, error: false },
      expected: { action: "interrupt" },
    },
    {
      name: "intermediate tool-call turn",
      prompt: { exists: true, promoted: true },
      assistant: { exists: true, completed: true, error: false, finish: "tool-calls" },
      expected: { action: "interrupt" },
    },
    {
      name: "terminal text turn",
      prompt: { exists: true, promoted: true },
      assistant: { exists: true, completed: true, error: false, finish: "stop" },
      expected: { action: "settle" },
    },
  ] as const

  for (const adapter of adapters) {
    for (const vector of lifecycleVectors) {
      test(`${adapter.name} adapter follows the shared lifecycle contract for ${vector.name}`, () => {
        expect(
          ModelCallOrchestration.decideRecovery(
            ModelCallOrchestration.observeChildLifecycle({
              status: "running",
              prompt: vector.prompt,
              assistant: {
                ...vector.assistant,
                continuationFinishes: adapter.continuationFinishes,
              },
            }),
          ),
        ).toEqual(vector.expected)
      })
    }
  }

  for (const status of statuses) {
    for (const slotReserved of [false, true]) {
      test(`decides record ${status} with slot=${slotReserved}`, () => {
        expect(
          ModelCallOrchestration.decideRecovery({
            stage: "record",
            status,
            slotReserved,
          }),
        ).toEqual(
          terminal.has(status)
            ? { action: "deliver" }
            : {
                action: "prepare",
                reserveSlot: !slotReserved,
              },
        )
      })
    }
  }

  for (const status of statuses) {
    for (const assistant of assistants) {
      for (const prompt of prompts) {
        test(`decides child ${status} with assistant=${assistant} and prompt=${prompt}`, () => {
          expect(
            ModelCallOrchestration.decideRecovery({
              stage: "child",
              status,
              prompt,
              assistant,
            }),
          ).toEqual(
            terminal.has(status)
              ? { action: "deliver" }
              : assistant === "terminal"
                ? { action: "settle" }
                : assistant === "incomplete" || assistant === "continuation" || prompt === "promoted"
                  ? { action: "interrupt" }
                  : { action: "resume" },
          )
        })
      }
    }
  }

  test("classifies durable prompt admission independently from assistant progress", () => {
    expect(ModelCallOrchestration.classifyPromptAdmission({ exists: false, promoted: false })).toBe("missing")
    expect(ModelCallOrchestration.classifyPromptAdmission({ exists: true, promoted: false })).toBe("admitted")
    expect(ModelCallOrchestration.classifyPromptAdmission({ exists: true, promoted: true })).toBe("promoted")
  })

  test("classifies assistant turns through runtime-supplied continuation evidence", () => {
    expect(
      ModelCallOrchestration.classifyAssistantTurn({
        exists: false,
        completed: false,
        error: false,
      }),
    ).toBe("none")
    expect(
      ModelCallOrchestration.classifyAssistantTurn({
        exists: true,
        completed: false,
        error: false,
      }),
    ).toBe("incomplete")
    expect(
      ModelCallOrchestration.classifyAssistantTurn({
        exists: true,
        completed: true,
        error: false,
        finish: "tool-calls",
        continuationFinishes: ["tool-calls"],
      }),
    ).toBe("continuation")
    expect(
      ModelCallOrchestration.classifyAssistantTurn({
        exists: true,
        completed: true,
        error: false,
        finish: "stop",
        continuation: true,
      }),
    ).toBe("continuation")
    expect(
      ModelCallOrchestration.classifyAssistantTurn({
        exists: true,
        completed: false,
        error: true,
        finish: "tool-calls",
        continuation: true,
      }),
    ).toBe("terminal")
    expect(
      ModelCallOrchestration.classifyAssistantTurn({
        exists: true,
        completed: true,
        error: false,
        finish: "stop",
      }),
    ).toBe("terminal")
  })
})

describe("ModelCallOrchestration structured output", () => {
  const schema = {
    type: "object",
    properties: {
      answer: { type: "string" },
    },
    required: ["answer"],
    additionalProperties: false,
  }

  test("validates object-root schemas before reservation", () => {
    expect(ModelCallOrchestration.validateOutputSchema(schema)).toEqual({ valid: true })
    expect(ModelCallOrchestration.validateOutputSchema({ type: "array" })).toEqual({
      valid: false,
      error: 'output_schema must have an object root (`type: "object"`)',
    })
    expect(
      ModelCallOrchestration.validateOutputSchema({
        type: "object",
        properties: {
          answer: { type: "not-a-json-schema-type" },
        },
      }),
    ).toMatchObject({
      valid: false,
      error: expect.stringContaining("Invalid output_schema:"),
    })
  })

  test("accepts direct values and fenced JSON", () => {
    expect(ModelCallOrchestration.validateStructured(schema, { answer: "direct" })).toEqual({
      structured: { answer: "direct" },
    })
    expect(ModelCallOrchestration.validateStructured(schema, '```json\n{"answer":"fenced"}\n```')).toEqual({
      structured: { answer: "fenced" },
    })
    expect(ModelCallOrchestration.validateStructured(undefined, "plain text")).toEqual({
      structured: undefined,
    })
  })

  test("reports invalid JSON and schema violations", () => {
    expect(ModelCallOrchestration.validateStructured(schema, "not json")).toEqual({
      code: "structured_output_invalid",
      error: "Response is not valid JSON",
    })
    expect(ModelCallOrchestration.validateStructured(schema, '{"answer":1}')).toMatchObject({
      code: "structured_output_invalid",
      error: expect.stringContaining("must be string"),
    })
  })

  test("rejects oversized or unserializable values without returning partial JSON", () => {
    expect(
      ModelCallOrchestration.validateStructured(schema, {
        answer: "x".repeat(ModelCallOrchestration.MAX_STRUCTURED_BYTES),
      }),
    ).toEqual({
      code: "structured_output_too_large",
      error: "Structured output exceeds the 1 MiB storage limit",
    })

    const cyclic: { answer: string; self?: unknown } = { answer: "cycle" }
    cyclic.self = cyclic
    expect(ModelCallOrchestration.validateStructured(schema, cyclic)).toMatchObject({
      code: "structured_output_invalid",
      error: expect.stringContaining("cyclic"),
    })
  })

  test("builds initial and corrective prompts without changing native structured prompts", () => {
    expect(ModelCallOrchestration.initialPrompt({ prompt: "Review this" })).toBe("Review this")
    expect(
      ModelCallOrchestration.initialPrompt({
        prompt: "Review this",
        outputSchema: schema,
        nativeStructured: true,
      }),
    ).toBe("Review this")
    expect(
      ModelCallOrchestration.initialPrompt({
        prompt: "Review this",
        outputSchema: schema,
      }),
    ).toContain("Return only one JSON object")
    expect(ModelCallOrchestration.correctionPrompt(schema)).toContain(JSON.stringify(schema))
  })
})

describe("ModelCallOrchestration provenance", () => {
  test("treats omitted and default variants as the same exact model", () => {
    expect(
      ModelCallOrchestration.compareProvenance(
        { providerID: "openai", id: "gpt-5", variant: "default" },
        { providerID: "openai", id: "gpt-5" },
      ),
    ).toMatchObject({
      matches: true,
      expected: { providerID: "openai", id: "gpt-5" },
      actual: { providerID: "openai", id: "gpt-5" },
    })
  })

  test("requires exact provider, model ID, and non-default variant", () => {
    for (const actual of [
      { providerID: "other", id: "models/team/model", variant: "review" },
      { providerID: "provider", id: "models/team/other", variant: "review" },
      { providerID: "provider", id: "models/team/model", variant: "fast" },
    ]) {
      const result = ModelCallOrchestration.compareProvenance(
        { providerID: "provider", id: "models/team/model", variant: "review" },
        actual,
      )
      expect(result.matches).toBeFalse()
      if (!result.matches) {
        expect(result.error.code).toBe("model_mismatch")
        expect(result.error.message).toContain("Expected provider/models/team/model/review")
      }
    }
  })
})
