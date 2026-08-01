import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { ModelCall } from "../src/model-call"
import { Model } from "../src/model"
import { Provider } from "../src/provider"
import { SessionID } from "../src/session-id"
import { SessionMessage } from "../src/session-message"

describe("ModelCall", () => {
  test("defines stable call IDs and lifecycle statuses", () => {
    expect(ModelCall.CallID.create()).toStartWith("mcl_")
    const decode = Schema.decodeUnknownSync(ModelCall.Status)
    expect(
      ["preparing", "queued", "running", "completed", "failed", "cancelled", "interrupted"].map((status) =>
        decode(status),
      ),
    ).toEqual(["preparing", "queued", "running", "completed", "failed", "cancelled", "interrupted"])
  })

  test("validates model_call and models inputs", () => {
    const model = {
      providerID: Provider.ID.make("anthropic"),
      id: Model.ID.make("catalog/claude-sonnet"),
      variant: Model.VariantID.make("thinking/high"),
    }
    expect(
      Schema.decodeUnknownSync(ModelCall.CallInput)({
        model,
        prompt: "Review this implementation",
        background: true,
        output_schema: { type: "object", required: ["findings"] },
      }),
    ).toEqual({
      model,
      prompt: "Review this implementation",
      background: true,
      output_schema: { type: "object", required: ["findings"] },
    })
    expect(() => Schema.decodeUnknownSync(ModelCall.ListInput)({ limit: ModelCall.MAX_LIST_LIMIT + 1 })).toThrow()
    expect(() => Schema.decodeUnknownSync(ModelCall.ListInput)({ cursor: "not-a-cursor" })).toThrow()
    expect(Schema.decodeUnknownSync(ModelCall.ListInput)({ query: "claude", tools: true, cursor: "model:20" })).toEqual(
      {
        query: "claude",
        tools: true,
        cursor: "model:20",
      },
    )
  })

  test("keeps the public discovery and call result shapes explicit", () => {
    expect(Object.keys(ModelCall.CallableModel.fields)).toEqual([
      "ref",
      "name",
      "description",
      "family",
      "capabilities",
      "variants",
      "status",
      "limits",
      "cost",
    ])
    expect(Object.keys(ModelCall.ListResult.fields)).toEqual(["items", "nextCursor"])
    expect(Object.keys(ModelCall.CallResult.fields)).toEqual([
      "callID",
      "parentSessionID",
      "childSessionID",
      "requestedModel",
      "actualModel",
      "mode",
      "status",
      "text",
      "structured",
      "error",
      "usage",
    ])
  })

  test("captures child-session provenance without provider internals", () => {
    const callID = ModelCall.CallID.create()
    const requestedModel = {
      providerID: Provider.ID.make("openai"),
      id: Model.ID.make("gpt-5"),
    }
    expect(
      Schema.decodeUnknownSync(ModelCall.Origin)({
        type: "model_call",
        callID,
        parentSessionID: SessionID.make("ses_parent"),
        parentAssistantMessageID: SessionMessage.ID.make("msg_parent"),
        parentToolCallID: "tool-call",
        requestedModel,
        outputSchema: { type: "object" },
      }),
    ).toEqual({
      type: "model_call",
      callID,
      parentSessionID: SessionID.make("ses_parent"),
      parentAssistantMessageID: SessionMessage.ID.make("msg_parent"),
      parentToolCallID: "tool-call",
      requestedModel,
      outputSchema: { type: "object" },
    })
  })

  test("tags permission snapshots by runtime generation", () => {
    expect(
      Schema.decodeUnknownSync(ModelCall.PermissionSnapshot)({
        version: "legacy",
        rules: [{ permission: "model_call", pattern: "*", action: "ask" }],
      }),
    ).toEqual({
      version: "legacy",
      rules: [{ permission: "model_call", pattern: "*", action: "ask" }],
    })
    expect(
      Schema.decodeUnknownSync(ModelCall.PermissionSnapshot)({
        version: "v2",
        rules: [{ action: "model_call", resource: "*", effect: "deny" }],
      }),
    ).toEqual({
      version: "v2",
      rules: [{ action: "model_call", resource: "*", effect: "deny" }],
    })
  })

  test("publishes every lifecycle event as durable version 1 by call aggregate", () => {
    expect(ModelCall.Event.Definitions).toEqual([
      ModelCall.Event.Requested,
      ModelCall.Event.Prepared,
      ModelCall.Event.Queued,
      ModelCall.Event.Started,
      ModelCall.Event.CorrectionRequested,
      ModelCall.Event.Completed,
      ModelCall.Event.Failed,
      ModelCall.Event.Cancelled,
      ModelCall.Event.Interrupted,
      ModelCall.Event.Detached,
      ModelCall.Event.ResultDelivered,
    ])
    expect(
      ModelCall.Event.Definitions.map((definition) => ({
        aggregate: definition.durable?.aggregate,
        version: definition.durable?.version,
      })),
    ).toEqual(Array.from({ length: 11 }, () => ({ aggregate: "callID", version: 1 })))
    expect(Object.keys(ModelCall.Event.Requested.data.fields)).toEqual([
      "timestamp",
      "callID",
      "origin",
      "requestedModel",
      "prompt",
      "system",
      "background",
      "output_schema",
      "childSessionID",
      "childPromptID",
      "correctionPromptID",
      "completionMessageID",
      "agent",
      "actualModel",
      "location",
      "permission",
      "runtime",
      "depth",
    ])
    expect(Schema.decodeUnknownSync(ModelCall.Event.Prepared.data.fields.slot)(ModelCall.MAX_ACTIVE_CHILDREN - 1)).toBe(
      ModelCall.MAX_ACTIVE_CHILDREN - 1,
    )
    expect(() =>
      Schema.decodeUnknownSync(ModelCall.Event.Prepared.data.fields.slot)(ModelCall.MAX_ACTIVE_CHILDREN),
    ).toThrow()
    expect(Object.keys(ModelCall.Event.Failed.data.fields)).toEqual(["timestamp", "callID", "error", "text", "usage"])
    expect(Object.keys(ModelCall.Event.Cancelled.data.fields)).toEqual([
      "timestamp",
      "callID",
      "foregroundOnly",
      "usage",
    ])
    expect(Object.keys(ModelCall.Event.Interrupted.data.fields)).toEqual(["timestamp", "callID", "error", "usage"])
  })
})
