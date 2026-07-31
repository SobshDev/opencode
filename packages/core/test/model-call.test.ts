import { describe, expect } from "bun:test"
import { ModelCall } from "@opencode-ai/schema/model-call"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { EventTable } from "@opencode-ai/core/event/sql"
import { Location } from "@opencode-ai/core/location"
import { ModelCallV2 } from "@opencode-ai/core/model-call"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { AgentV2 } from "@opencode-ai/core/agent"
import { eq } from "drizzle-orm"
import { DateTime, Effect } from "effect"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, ModelCallV2.node])))

const location = Location.Ref.make({ directory: AbsolutePath.make("/project") })
const parentSessionID = SessionV2.ID.make("ses_model_call_parent")
const parentAssistantMessageID = SessionMessage.ID.make("msg_model_call_parent")
const agent = AgentV2.ID.make("build")
const requestedModel = ModelV2.Ref.make({
  providerID: ProviderV2.ID.anthropic,
  id: ModelV2.ID.make("claude-opus"),
})
const actualModel = ModelV2.Ref.make({
  providerID: ProviderV2.ID.anthropic,
  id: ModelV2.ID.make("claude-sonnet"),
})
const usage = {
  cost: 0.25,
  tokens: {
    input: 10,
    output: 20,
    reasoning: 3,
    cache: { read: 4, write: 5 },
  },
} satisfies ModelCall.Usage

const reserveInput = (overrides: Partial<ModelCallV2.ReserveInput> = {}): ModelCallV2.ReserveInput => ({
  parentSessionID,
  parentAssistantMessageID,
  parentToolCallID: "tool-model-call",
  agent,
  requestedModel,
  actualModel,
  location,
  permission: { version: "v2", rules: [] },
  prompt: "Review the implementation",
  outputSchema: { type: "object", required: ["findings"] },
  runtime: "v2",
  background: false,
  ...overrides,
})

const insertSession = (db: Database.Interface["db"], id: SessionV2.ID, parentID?: SessionV2.ID) =>
  db
    .insert(SessionTable)
    .values({
      id,
      project_id: ProjectV2.ID.global,
      ...(parentID === undefined ? {} : { parent_id: parentID }),
      slug: id,
      directory: location.directory,
      title: id,
      version: "test",
      model: actualModel,
    })
    .run()
    .pipe(Effect.orDie)

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: ProjectV2.ID.global, worktree: location.directory, sandboxes: [] })
    .run()
    .pipe(Effect.orDie)
  yield* insertSession(db, parentSessionID)
  return { calls: yield* ModelCallV2.Service, db }
})

describe("ModelCallV2", () => {
  it.effect("reconciles concurrent exact reservation retries to one durable call", () =>
    Effect.gen(function* () {
      const { calls } = yield* setup
      const input = reserveInput()
      const records = yield* Effect.all([calls.reserve(input), calls.reserve(input)], {
        concurrency: "unbounded",
      })

      expect(records[1]).toEqual(records[0])
      expect(records[0]).toMatchObject({
        parentSessionID,
        parentAssistantMessageID,
        parentToolCallID: input.parentToolCallID,
        requestedModel,
        actualModel,
        permission: input.permission,
        prompt: input.prompt,
        outputSchema: input.outputSchema,
        runtime: "v2",
        requestedBackground: false,
        background: false,
        depth: 1,
        slot: 0,
        status: "preparing",
      })
      expect(yield* calls.findInvocation(input)).toEqual(records[0])
      expect(yield* calls.list(parentSessionID)).toEqual([records[0]])
    }),
  )

  it.effect("rejects conflicting reuse of one parent tool invocation", () =>
    Effect.gen(function* () {
      const { calls } = yield* setup
      const input = reserveInput()
      const original = yield* calls.reserve(input)
      const conflict = yield* calls.reserve({ ...input, prompt: "Implement instead" }).pipe(Effect.flip)

      expect(conflict).toBeInstanceOf(ModelCallV2.InvocationConflictError)
      expect(conflict).toMatchObject({
        parentSessionID,
        parentAssistantMessageID,
        parentToolCallID: input.parentToolCallID,
      })
      expect(yield* calls.get(original.id)).toEqual(original)
      expect(yield* calls.list(parentSessionID)).toHaveLength(1)
    }),
  )

  it.effect("rejects permission snapshots that drift or do not match the runtime", () =>
    Effect.gen(function* () {
      const { calls } = yield* setup
      const input = reserveInput()
      const original = yield* calls.reserve(input)
      const drift = yield* calls
        .reserve({
          ...input,
          permission: {
            version: "v2",
            rules: [{ action: "model_call", resource: "*", effect: "allow" }],
          },
        })
        .pipe(Effect.flip)
      const mismatch = yield* calls
        .reserve({
          ...input,
          parentToolCallID: "tool-permission-mismatch",
          permission: { version: "legacy", rules: [] },
        })
        .pipe(Effect.flip)

      expect(drift).toBeInstanceOf(ModelCallV2.InvocationConflictError)
      expect(mismatch).toBeInstanceOf(ModelCallV2.PermissionSnapshotMismatchError)
      expect(yield* calls.get(original.id)).toMatchObject({ permission: input.permission })
    }),
  )

  it.effect("finishes a crash-left Requested reservation on exact concurrent retry", () =>
    Effect.gen(function* () {
      const { calls } = yield* setup
      const events = yield* EventV2.Service
      const input = reserveInput({ parentToolCallID: "tool-requested-crash" })
      const callID = ModelCall.CallID.create()
      const childSessionID = SessionV2.ID.create()
      const childPromptID = SessionMessage.ID.create()
      const correctionPromptID = SessionMessage.ID.create()
      const completionMessageID = SessionMessage.ID.create()
      yield* events.publish(
        ModelCall.Event.Requested,
        {
          timestamp: yield* DateTime.now,
          callID,
          origin: {
            type: "model_call",
            callID,
            parentSessionID,
            parentAssistantMessageID,
            parentToolCallID: input.parentToolCallID,
            requestedModel,
            outputSchema: input.outputSchema,
          },
          requestedModel,
          prompt: input.prompt,
          background: false,
          output_schema: input.outputSchema,
          childSessionID,
          childPromptID,
          correctionPromptID,
          completionMessageID,
          agent,
          actualModel,
          location,
          permission: input.permission,
          runtime: "v2",
          depth: 1,
        },
        { location },
      )

      const requested = yield* calls.get(callID)
      expect(requested.status).toBe("preparing")
      expect(requested.slot).toBeUndefined()
      expect(yield* calls.recoverable("v2")).toContainEqual(expect.objectContaining({ id: callID }))
      const retried = yield* Effect.all([calls.reserve(input), calls.reserve(input)], {
        concurrency: "unbounded",
      })

      expect(retried[0]).toEqual(retried[1])
      expect(retried[0]).toMatchObject({ id: callID, status: "preparing", slot: 0 })
      expect(yield* calls.list(parentSessionID)).toHaveLength(1)
    }),
  )

  it.effect("bounds active direct children to 20 slots and reuses a terminal slot", () =>
    Effect.gen(function* () {
      const { calls } = yield* setup
      const active = yield* Effect.forEach(
        Array.from({ length: ModelCall.MAX_ACTIVE_CHILDREN }, (_, index) => index),
        (index) => calls.reserve(reserveInput({ parentToolCallID: `tool-active-${index}` })),
      )

      expect(active.map((record) => record.slot)).toEqual(
        Array.from({ length: ModelCall.MAX_ACTIVE_CHILDREN }, (_, index) => index),
      )
      const overflow = yield* calls.reserve(reserveInput({ parentToolCallID: "tool-overflow" }))
      expect(overflow).toMatchObject({
        status: "failed",
        error: {
          code: "child_limit",
          message: "A Session can have at most 20 active direct model-call children",
        },
      })
      expect(overflow.slot).toBeUndefined()

      expect((yield* calls.completed(active[1].id, { text: "done", usage })).slot).toBeUndefined()
      expect((yield* calls.reserve(reserveInput({ parentToolCallID: "tool-replacement" }))).slot).toBe(1)
    }),
  )

  it.effect("atomically bounds 21 concurrent direct-child reservations", () =>
    Effect.gen(function* () {
      const { calls } = yield* setup
      const records = yield* Effect.forEach(
        Array.from({ length: ModelCall.MAX_ACTIVE_CHILDREN + 1 }, (_, index) => index),
        (index) => calls.reserve(reserveInput({ parentToolCallID: `tool-concurrent-${index}` })),
        { concurrency: "unbounded" },
      )
      const active = records.filter((record) => record.status === "preparing")
      const failed = records.filter((record) => record.status === "failed")

      expect(active).toHaveLength(ModelCall.MAX_ACTIVE_CHILDREN)
      expect(active.map((record) => record.slot).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual(
        Array.from({ length: ModelCall.MAX_ACTIVE_CHILDREN }, (_, index) => index),
      )
      expect(failed).toHaveLength(1)
      expect(failed[0]?.slot).toBeUndefined()
      expect(failed[0]).toMatchObject({
        error: {
          code: "child_limit",
          message: "A Session can have at most 20 active direct model-call children",
        },
      })
      expect(yield* calls.list(parentSessionID)).toHaveLength(ModelCall.MAX_ACTIVE_CHILDREN + 1)
    }),
  )

  it.effect("allows same-model delegation through depth two and fails depth three", () =>
    Effect.gen(function* () {
      const { calls, db } = yield* setup
      const model = actualModel
      const first = yield* calls.reserve(
        reserveInput({
          requestedModel: model,
          actualModel: model,
          parentToolCallID: "tool-depth-one",
        }),
      )
      yield* insertSession(db, first.childSessionID, parentSessionID)

      const second = yield* calls.reserve(
        reserveInput({
          parentSessionID: first.childSessionID,
          parentAssistantMessageID: SessionMessage.ID.make("msg_depth_two"),
          parentToolCallID: "tool-depth-two",
          requestedModel: model,
          actualModel: model,
        }),
      )
      yield* insertSession(db, second.childSessionID, first.childSessionID)

      const third = yield* calls.reserve(
        reserveInput({
          parentSessionID: second.childSessionID,
          parentAssistantMessageID: SessionMessage.ID.make("msg_depth_three"),
          parentToolCallID: "tool-depth-three",
          requestedModel: model,
          actualModel: model,
        }),
      )

      expect(first).toMatchObject({ depth: 1, status: "preparing", requestedModel: model, actualModel: model })
      expect(second).toMatchObject({ depth: 2, status: "preparing", requestedModel: model, actualModel: model })
      expect(third).toMatchObject({
        depth: 3,
        status: "failed",
        error: { code: "depth_limit", message: "Model calls are limited to depth two" },
      })
      expect(third.slot).toBeUndefined()
    }),
  )

  it.effect("projects lifecycle, correction, usage, and the public result", () =>
    Effect.gen(function* () {
      const { calls } = yield* setup
      const reserved = yield* calls.reserve(reserveInput())
      const queued = yield* calls.queued(reserved.id)
      const running = yield* calls.started(reserved.id)
      const corrected = yield* calls.requestCorrection(reserved.id, "$.findings is required")
      const completed = yield* calls.completed(reserved.id, {
        text: "No blocking findings.",
        structured: { findings: [] },
        usage,
      })

      expect(queued).toMatchObject({ status: "queued", timeQueued: expect.any(Number) })
      expect(running).toMatchObject({ status: "running", timeStarted: expect.any(Number) })
      expect(corrected).toMatchObject({ status: "running", validationAttempts: 1 })
      expect(completed).toMatchObject({
        status: "completed",
        text: "No blocking findings.",
        structured: { findings: [] },
        usage,
        timeCompleted: expect.any(Number),
      })
      expect(completed.slot).toBeUndefined()
      expect(ModelCallV2.result(completed)).toEqual({
        callID: completed.id,
        parentSessionID,
        childSessionID: completed.childSessionID,
        requestedModel,
        actualModel,
        mode: "foreground",
        status: "completed",
        text: "No blocking findings.",
        structured: { findings: [] },
        usage,
      })
    }),
  )

  it.effect("publishes model-call lifecycle events with their Location", () =>
    Effect.gen(function* () {
      const { calls } = yield* setup
      const events = yield* EventV2.Service
      const observed: EventV2.Payload[] = []
      const types = new Set<string>(ModelCall.Event.Definitions.map((definition) => definition.type))
      const unsubscribe = yield* events.listen((event) =>
        Effect.sync(() => {
          if (types.has(event.type)) observed.push(event)
        }),
      )
      const reserved = yield* calls.reserve(reserveInput({ parentToolCallID: "tool-location-events" }))
      yield* calls.queued(reserved.id)
      yield* calls.started(reserved.id)
      yield* calls.requestCorrection(reserved.id, "invalid")
      yield* calls.completed(reserved.id, { text: "done", usage })
      yield* unsubscribe

      expect(observed.map((event) => event.type)).toEqual([
        ModelCall.Event.Requested.type,
        ModelCall.Event.Prepared.type,
        ModelCall.Event.Queued.type,
        ModelCall.Event.Started.type,
        ModelCall.Event.CorrectionRequested.type,
        ModelCall.Event.Completed.type,
      ])
      expect(observed.every((event) => JSON.stringify(event.location) === JSON.stringify(location))).toBe(true)
    }),
  )

  it.effect("settles a concurrent terminal race exactly once", () =>
    Effect.gen(function* () {
      const { calls, db } = yield* setup
      const reserved = yield* calls.reserve(reserveInput())
      const settled = yield* Effect.all(
        [
          calls.completed(reserved.id, { text: "completed", usage }),
          calls.failed(reserved.id, { code: "review_failed", message: "failed" }),
        ],
        { concurrency: "unbounded" },
      )
      const current = yield* calls.get(reserved.id)

      expect(["completed", "failed"]).toContain(current.status)
      expect(settled.map((record) => record.status)).toEqual([current.status, current.status])
      expect(current.slot).toBeUndefined()
      const terminalTypes = new Set([
        EventV2.versionedType(ModelCall.Event.Completed.type, 1),
        EventV2.versionedType(ModelCall.Event.Failed.type, 1),
      ])
      expect(
        (yield* db
          .select()
          .from(EventTable)
          .where(eq(EventTable.aggregate_id, reserved.id))
          .all()
          .pipe(Effect.orDie)).filter((event) => terminalTypes.has(event.type)),
      ).toHaveLength(1)
    }),
  )

  it.effect("persists available child text and usage on failure", () =>
    Effect.gen(function* () {
      const { calls } = yield* setup
      const reserved = yield* calls.reserve(reserveInput())
      const failed = yield* calls.failed(
        reserved.id,
        { code: "structured_output_invalid", message: "$.findings is required" },
        { text: '{"wrong":true}', usage },
      )

      expect(failed).toMatchObject({
        status: "failed",
        text: '{"wrong":true}',
        usage,
        error: { code: "structured_output_invalid", message: "$.findings is required" },
      })
      expect(ModelCallV2.result(failed)).toMatchObject({ status: "failed", text: '{"wrong":true}', usage })
    }),
  )

  it.effect("preserves accrued usage when cancellation or recovery interruption wins", () =>
    Effect.gen(function* () {
      const { calls } = yield* setup
      const cancelled = yield* calls.reserve(reserveInput({ parentToolCallID: "tool-usage-cancelled" }))
      const interrupted = yield* calls.reserve(reserveInput({ parentToolCallID: "tool-usage-interrupted" }))

      expect(yield* calls.cancelled(cancelled.id, { usage })).toMatchObject({
        status: "cancelled",
        usage,
      })
      expect(yield* calls.interrupted(interrupted.id, usage)).toMatchObject({
        status: "interrupted",
        usage,
        error: { code: "unknown_outcome", outcomeUnknown: true },
      })
    }),
  )

  it.effect("detaches a foreground call idempotently", () =>
    Effect.gen(function* () {
      const { calls } = yield* setup
      const input = reserveInput()
      const reserved = yield* calls.reserve(input)
      const detached = yield* calls.detach(reserved.id)

      expect(detached).toMatchObject({
        id: reserved.id,
        requestedBackground: false,
        background: true,
        status: "preparing",
        slot: 0,
      })
      expect(yield* calls.detach(reserved.id)).toEqual(detached)
      expect(yield* calls.reserve(input)).toEqual(detached)
      expect(yield* calls.cancelled(reserved.id, { foregroundOnly: true })).toEqual(detached)
      expect(ModelCallV2.result(detached)).toMatchObject({ callID: reserved.id, mode: "background" })
    }),
  )

  it.effect("does not flip a terminal foreground call during a completion-detach race", () =>
    Effect.gen(function* () {
      const { calls } = yield* setup
      const outcomes = yield* Effect.forEach(
        Array.from({ length: 20 }, (_, index) => index),
        (index) =>
          Effect.gen(function* () {
            const reserved = yield* calls.reserve(
              reserveInput({ parentToolCallID: `tool-terminal-detach-race-${index}` }),
            )
            const settled = yield* Effect.all(
              [calls.completed(reserved.id, { text: "done", usage }), calls.detach(reserved.id)],
              { concurrency: "unbounded" },
            )
            const current = yield* calls.get(reserved.id)
            expect(current.status).toBe("completed")
            expect(settled[0]).toEqual(current)
            expect(settled[1]).toEqual(current)
            if (!current.background) {
              expect((yield* calls.detach(current.id)).background).toBe(false)
              expect((yield* calls.delivered(current.id)).deliveredAt).toBeUndefined()
            }
            return current.background
          }),
      )

      expect(outcomes).toContain(false)
    }),
  )
  it.effect("marks a background result delivered exactly once under concurrency", () =>
    Effect.gen(function* () {
      const { calls, db } = yield* setup
      const reserved = yield* calls.reserve(reserveInput({ background: true }))
      yield* calls.completed(reserved.id, { text: "done", usage })
      const delivered = yield* Effect.all([calls.delivered(reserved.id), calls.delivered(reserved.id)], {
        concurrency: "unbounded",
      })

      expect(delivered[0].deliveredAt).toEqual(expect.any(Number))
      expect(delivered[1].deliveredAt).toBe(delivered[0].deliveredAt)
      expect(
        (yield* db
          .select()
          .from(EventTable)
          .where(eq(EventTable.aggregate_id, reserved.id))
          .all()
          .pipe(Effect.orDie)).filter(
          (event) => event.type === EventV2.versionedType(ModelCall.Event.ResultDelivered.type, 1),
        ),
      ).toHaveLength(1)
    }),
  )

  it.effect("recovers active calls and undelivered background results by runtime", () =>
    Effect.gen(function* () {
      const { calls } = yield* setup
      const active = yield* calls.reserve(reserveInput({ parentToolCallID: "tool-active" }))
      const background = yield* calls.reserve(reserveInput({ parentToolCallID: "tool-background", background: true }))
      const legacy = yield* calls.reserve(
        reserveInput({
          parentToolCallID: "tool-legacy",
          background: true,
          runtime: "legacy",
          permission: { version: "legacy", rules: [] },
        }),
      )
      yield* calls.completed(background.id, { text: "background", usage })
      yield* calls.completed(legacy.id, { text: "legacy", usage })

      expect(new Set((yield* calls.recoverable("v2")).map((record) => record.id))).toEqual(
        new Set([active.id, background.id]),
      )
      expect((yield* calls.recoverable("legacy")).map((record) => record.id)).toEqual([legacy.id])

      const delivered = yield* calls.delivered(background.id)
      expect(delivered.deliveredAt).toEqual(expect.any(Number))
      expect((yield* calls.recoverable("v2")).map((record) => record.id)).toEqual([active.id])

      yield* calls.completed(active.id, { text: "foreground", usage })
      expect(yield* calls.recoverable("v2")).toEqual([])
    }),
  )
})
