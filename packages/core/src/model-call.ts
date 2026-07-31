export * as ModelCallV2 from "./model-call"

import { ModelCall } from "@opencode-ai/schema/model-call"
import { Agent } from "@opencode-ai/schema/agent"
import { Location } from "@opencode-ai/schema/location"
import { Model } from "@opencode-ai/schema/model"
import { Session } from "@opencode-ai/schema/session"
import { SessionMessage } from "@opencode-ai/schema/session-message"
import { and, asc, eq, inArray, isNull, ne, or, type SQL } from "drizzle-orm"
import { Context, DateTime, Effect, Layer, Schema } from "effect"
import { isDeepStrictEqual } from "node:util"
import { Database } from "./database/database"
import { makeGlobalNode } from "./effect/app-node"
import { EventV2 } from "./event"
import { ModelCallTable } from "./model-call.sql"
import { SessionTable } from "./session/sql"

export type Runtime = "legacy" | "v2"

export type Info = {
  readonly id: ModelCall.CallID
  readonly parentSessionID: Session.ID
  readonly parentAssistantMessageID: SessionMessage.ID
  readonly parentToolCallID: string
  readonly childSessionID: Session.ID
  readonly childPromptID: SessionMessage.ID
  readonly correctionPromptID: SessionMessage.ID
  readonly completionMessageID: SessionMessage.ID
  readonly agent: Agent.ID
  readonly requestedModel: Model.Ref
  readonly actualModel: Model.Ref
  readonly location: Location.Ref
  readonly permission: ModelCall.PermissionSnapshot
  readonly prompt: string
  readonly system?: string
  readonly outputSchema?: Record<string, unknown>
  readonly runtime: Runtime
  readonly requestedBackground: boolean
  readonly background: boolean
  readonly depth: number
  readonly slot?: number
  readonly status: ModelCall.Status
  readonly text?: string
  readonly structured?: unknown
  readonly error?: ModelCall.Error
  readonly usage?: ModelCall.Usage
  readonly validationAttempts: number
  readonly deliveredAt?: number
  readonly timeCreated: number
  readonly timeUpdated: number
  readonly timeQueued?: number
  readonly timeStarted?: number
  readonly timeCompleted?: number
}

export type ReserveInput = {
  readonly parentSessionID: Session.ID
  readonly parentAssistantMessageID: SessionMessage.ID
  readonly parentToolCallID: string
  readonly agent: Agent.ID
  readonly requestedModel: Model.Ref
  readonly actualModel: Model.Ref
  readonly location: Location.Ref
  readonly permission: ModelCall.PermissionSnapshot
  readonly prompt: string
  readonly system?: string
  readonly outputSchema?: Record<string, unknown>
  readonly runtime: Runtime
  readonly background: boolean
}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("ModelCall.NotFoundError", {
  callID: ModelCall.CallID,
}) {
  override get message() {
    return `Model call not found: ${this.callID}`
  }
}

export class InvocationConflictError extends Schema.TaggedErrorClass<InvocationConflictError>()(
  "ModelCall.InvocationConflictError",
  {
    parentSessionID: Session.ID,
    parentAssistantMessageID: SessionMessage.ID,
    parentToolCallID: Schema.String,
  },
) {
  override get message() {
    return `Model call invocation was reused with different input: ${this.parentToolCallID}`
  }
}

export class PermissionSnapshotMismatchError extends Schema.TaggedErrorClass<PermissionSnapshotMismatchError>()(
  "ModelCall.PermissionSnapshotMismatchError",
  {
    runtime: Schema.Literals(["legacy", "v2"]),
    version: Schema.Literals(["legacy", "v2"]),
  },
) {
  override get message() {
    return `Model call runtime ${this.runtime} cannot use a ${this.version} permission snapshot`
  }
}

class InvocationExists extends Error {}
class SlotTaken extends Error {}
class TransitionLost extends Error {}

const terminal = new Set<ModelCall.Status>(["completed", "failed", "cancelled", "interrupted"])

export const isTerminal = (status: ModelCall.Status) => terminal.has(status)

export const result = (record: Info): ModelCall.CallResult => ({
  callID: record.id,
  parentSessionID: record.parentSessionID,
  childSessionID: record.childSessionID,
  requestedModel: record.requestedModel,
  actualModel: record.actualModel,
  mode: record.background ? "background" : "foreground",
  status: record.status,
  ...(record.text === undefined ? {} : { text: record.text }),
  ...(record.structured === undefined ? {} : { structured: record.structured }),
  ...(record.error === undefined ? {} : { error: record.error }),
  ...(record.usage === undefined ? {} : { usage: record.usage }),
})

export interface Interface {
  readonly reserve: (
    input: ReserveInput,
  ) => Effect.Effect<Info, InvocationConflictError | PermissionSnapshotMismatchError>
  readonly get: (callID: ModelCall.CallID) => Effect.Effect<Info, NotFoundError>
  readonly find: (callID: ModelCall.CallID) => Effect.Effect<Info | undefined>
  readonly findInvocation: (input: {
    parentSessionID: Session.ID
    parentAssistantMessageID: SessionMessage.ID
    parentToolCallID: string
  }) => Effect.Effect<Info | undefined>
  readonly list: (parentSessionID: Session.ID) => Effect.Effect<ReadonlyArray<Info>>
  readonly recoverable: (runtime: Runtime) => Effect.Effect<ReadonlyArray<Info>>
  readonly queued: (callID: ModelCall.CallID) => Effect.Effect<Info, NotFoundError>
  readonly started: (callID: ModelCall.CallID) => Effect.Effect<Info, NotFoundError>
  readonly completed: (
    callID: ModelCall.CallID,
    output: { text: string; structured?: unknown; usage: ModelCall.Usage },
  ) => Effect.Effect<Info, NotFoundError>
  readonly failed: (
    callID: ModelCall.CallID,
    error: ModelCall.Error,
    output?: { text?: string; usage?: ModelCall.Usage },
  ) => Effect.Effect<Info, NotFoundError>
  readonly cancelled: (
    callID: ModelCall.CallID,
    options?: { foregroundOnly?: boolean; usage?: ModelCall.Usage },
  ) => Effect.Effect<Info, NotFoundError>
  readonly interrupted: (
    callID: ModelCall.CallID,
    usage?: ModelCall.Usage,
    error?: ModelCall.Error,
  ) => Effect.Effect<Info, NotFoundError>
  readonly detach: (callID: ModelCall.CallID) => Effect.Effect<Info, NotFoundError>
  readonly delivered: (callID: ModelCall.CallID) => Effect.Effect<Info, NotFoundError>
  readonly requestCorrection: (callID: ModelCall.CallID, validationError: string) => Effect.Effect<Info, NotFoundError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ModelCall") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const db = database.db
    const events = yield* EventV2.Service

    const fromRow = (row: typeof ModelCallTable.$inferSelect): Info => ({
      id: row.id,
      parentSessionID: row.parent_session_id,
      parentAssistantMessageID: row.parent_assistant_message_id,
      parentToolCallID: row.parent_tool_call_id,
      childSessionID: row.child_session_id,
      childPromptID: row.child_prompt_id,
      correctionPromptID: row.correction_prompt_id,
      completionMessageID: row.completion_message_id,
      agent: Agent.ID.make(row.agent_id),
      requestedModel: row.requested_model,
      actualModel: row.actual_model,
      location: row.location,
      permission: row.permission,
      prompt: row.prompt,
      ...(row.system === null ? {} : { system: row.system }),
      ...(row.output_schema === null ? {} : { outputSchema: row.output_schema }),
      runtime: row.runtime,
      requestedBackground: row.requested_background,
      background: row.background,
      depth: row.depth,
      ...(row.slot === null ? {} : { slot: row.slot }),
      status: row.status,
      ...(row.text === null ? {} : { text: row.text }),
      ...(row.structured === null ? {} : { structured: row.structured }),
      ...(row.error === null ? {} : { error: row.error }),
      ...(row.usage === null ? {} : { usage: row.usage }),
      validationAttempts: row.validation_attempts,
      ...(row.delivered_at === null ? {} : { deliveredAt: row.delivered_at }),
      timeCreated: row.time_created,
      timeUpdated: row.time_updated,
      ...(row.time_queued === null ? {} : { timeQueued: row.time_queued }),
      ...(row.time_started === null ? {} : { timeStarted: row.time_started }),
      ...(row.time_completed === null ? {} : { timeCompleted: row.time_completed }),
    })

    const find = Effect.fn("ModelCall.find")(function* (callID: ModelCall.CallID) {
      const row = yield* db.select().from(ModelCallTable).where(eq(ModelCallTable.id, callID)).get().pipe(Effect.orDie)
      return row ? fromRow(row) : undefined
    })

    const get = Effect.fn("ModelCall.get")(function* (callID: ModelCall.CallID) {
      const record = yield* find(callID)
      if (!record) return yield* new NotFoundError({ callID })
      return record
    })

    const findInvocation: Interface["findInvocation"] = Effect.fn("ModelCall.findInvocation")(function* (input) {
      const row = yield* db
        .select()
        .from(ModelCallTable)
        .where(
          and(
            eq(ModelCallTable.parent_session_id, input.parentSessionID),
            eq(ModelCallTable.parent_assistant_message_id, input.parentAssistantMessageID),
            eq(ModelCallTable.parent_tool_call_id, input.parentToolCallID),
          ),
        )
        .get()
        .pipe(Effect.orDie)
      return row ? fromRow(row) : undefined
    })

    const transition = <A>(callID: ModelCall.CallID, publish: Effect.Effect<A>): Effect.Effect<Info, NotFoundError> =>
      publish.pipe(
        Effect.asVoid,
        Effect.catchDefect((defect) => (defect instanceof TransitionLost ? Effect.void : Effect.die(defect))),
        Effect.andThen(get(callID)),
      )

    yield* events.project(ModelCall.Event.Requested, (event) =>
      Effect.gen(function* () {
        if (
          event.data.origin.callID !== event.data.callID ||
          !isDeepStrictEqual(event.data.origin.requestedModel, event.data.requestedModel) ||
          !isDeepStrictEqual(event.data.origin.outputSchema, event.data.output_schema) ||
          event.data.permission.version !== event.data.runtime
        )
          return yield* Effect.die(new TransitionLost())
        const existing = yield* db
          .select({ id: ModelCallTable.id })
          .from(ModelCallTable)
          .where(
            and(
              eq(ModelCallTable.parent_session_id, event.data.origin.parentSessionID),
              eq(ModelCallTable.parent_assistant_message_id, event.data.origin.parentAssistantMessageID),
              eq(ModelCallTable.parent_tool_call_id, event.data.origin.parentToolCallID),
            ),
          )
          .get()
          .pipe(Effect.orDie)
        if (existing) return yield* Effect.die(new InvocationExists())
        const timestamp = DateTime.toEpochMillis(event.data.timestamp)
        yield* db
          .insert(ModelCallTable)
          .values({
            id: event.data.callID,
            parent_session_id: event.data.origin.parentSessionID,
            parent_assistant_message_id: event.data.origin.parentAssistantMessageID,
            parent_tool_call_id: event.data.origin.parentToolCallID,
            child_session_id: event.data.childSessionID,
            child_prompt_id: event.data.childPromptID,
            correction_prompt_id: event.data.correctionPromptID,
            completion_message_id: event.data.completionMessageID,
            agent_id: event.data.agent,
            requested_model: event.data.requestedModel,
            actual_model: event.data.actualModel,
            location: event.data.location,
            permission: event.data.permission,
            prompt: event.data.prompt,
            system: event.data.system,
            output_schema: event.data.output_schema,
            runtime: event.data.runtime,
            requested_background: event.data.background,
            background: event.data.background,
            depth: event.data.depth,
            status: "preparing",
            time_created: timestamp,
            time_updated: timestamp,
          })
          .run()
          .pipe(Effect.orDie)
      }),
    )

    yield* events.project(ModelCall.Event.Prepared, (event) =>
      Effect.gen(function* () {
        const record = yield* get(event.data.callID).pipe(Effect.orDie)
        if (
          record.status !== "preparing" ||
          record.slot !== undefined ||
          record.childSessionID !== event.data.childSessionID ||
          record.childPromptID !== event.data.childPromptID ||
          record.completionMessageID !== event.data.completionMessageID ||
          record.agent !== event.data.agent ||
          record.runtime !== event.data.runtime ||
          record.depth !== event.data.depth ||
          !isDeepStrictEqual(record.actualModel, event.data.actualModel) ||
          !isDeepStrictEqual(record.location, event.data.location)
        )
          return yield* Effect.die(new TransitionLost())
        const occupied = yield* db
          .select({ id: ModelCallTable.id })
          .from(ModelCallTable)
          .where(
            and(
              eq(ModelCallTable.parent_session_id, record.parentSessionID),
              eq(ModelCallTable.slot, event.data.slot),
              ne(ModelCallTable.id, record.id),
            ),
          )
          .get()
          .pipe(Effect.orDie)
        if (occupied) return yield* Effect.die(new SlotTaken())
        const updated = yield* db
          .update(ModelCallTable)
          .set({ slot: event.data.slot, time_updated: DateTime.toEpochMillis(event.data.timestamp) })
          .where(and(eq(ModelCallTable.id, record.id), eq(ModelCallTable.status, "preparing")))
          .returning({ id: ModelCallTable.id })
          .get()
          .pipe(Effect.orDie)
        if (!updated) return yield* Effect.die(new TransitionLost())
      }),
    )

    yield* events.project(ModelCall.Event.Queued, (event) =>
      projectStatus(db, event.data.callID, ["preparing"], "queued", event.data.timestamp, {
        time_queued: DateTime.toEpochMillis(event.data.timestamp),
      }),
    )
    yield* events.project(ModelCall.Event.Started, (event) =>
      projectStatus(db, event.data.callID, ["preparing", "queued"], "running", event.data.timestamp, {
        time_started: DateTime.toEpochMillis(event.data.timestamp),
      }),
    )
    yield* events.project(ModelCall.Event.CorrectionRequested, (event) =>
      Effect.gen(function* () {
        const record = yield* get(event.data.callID).pipe(Effect.orDie)
        if (
          isTerminal(record.status) ||
          record.correctionPromptID !== event.data.correctionPromptID ||
          event.data.attempt !== record.validationAttempts + 1
        )
          return yield* Effect.die(new TransitionLost())
        const updated = yield* db
          .update(ModelCallTable)
          .set({
            validation_attempts: event.data.attempt,
            time_updated: DateTime.toEpochMillis(event.data.timestamp),
          })
          .where(
            and(
              eq(ModelCallTable.id, event.data.callID),
              eq(ModelCallTable.validation_attempts, record.validationAttempts),
            ),
          )
          .returning({ id: ModelCallTable.id })
          .get()
          .pipe(Effect.orDie)
        if (!updated) return yield* Effect.die(new TransitionLost())
      }),
    )
    yield* events.project(ModelCall.Event.Completed, (event) =>
      projectStatus(db, event.data.callID, ["preparing", "queued", "running"], "completed", event.data.timestamp, {
        text: event.data.text,
        structured: event.data.structured,
        usage: event.data.usage,
        error: null,
        slot: null,
        time_completed: DateTime.toEpochMillis(event.data.timestamp),
      }),
    )
    yield* events.project(ModelCall.Event.Failed, (event) =>
      projectStatus(db, event.data.callID, ["preparing", "queued", "running"], "failed", event.data.timestamp, {
        error: event.data.error,
        text: event.data.text,
        usage: event.data.usage,
        slot: null,
        time_completed: DateTime.toEpochMillis(event.data.timestamp),
      }),
    )
    yield* events.project(ModelCall.Event.Cancelled, (event) =>
      projectStatus(
        db,
        event.data.callID,
        ["preparing", "queued", "running"],
        "cancelled",
        event.data.timestamp,
        {
          usage: event.data.usage,
          slot: null,
          time_completed: DateTime.toEpochMillis(event.data.timestamp),
        },
        event.data.foregroundOnly ? eq(ModelCallTable.background, false) : undefined,
      ),
    )
    yield* events.project(ModelCall.Event.Interrupted, (event) =>
      projectStatus(db, event.data.callID, ["preparing", "queued", "running"], "interrupted", event.data.timestamp, {
        error: event.data.error ?? null,
        usage: event.data.usage,
        slot: null,
        time_completed: DateTime.toEpochMillis(event.data.timestamp),
      }),
    )
    yield* events.project(ModelCall.Event.Detached, (event) =>
      Effect.gen(function* () {
        const updated = yield* db
          .update(ModelCallTable)
          .set({ background: true, time_updated: DateTime.toEpochMillis(event.data.timestamp) })
          .where(
            and(
              eq(ModelCallTable.id, event.data.callID),
              eq(ModelCallTable.background, false),
              inArray(ModelCallTable.status, ["preparing", "queued", "running"]),
            ),
          )
          .returning({ id: ModelCallTable.id })
          .get()
          .pipe(Effect.orDie)
        if (!updated) {
          const record = yield* get(event.data.callID).pipe(Effect.orDie)
          if (!record.background) return yield* Effect.die(new TransitionLost())
        }
      }),
    )
    yield* events.project(ModelCall.Event.ResultDelivered, (event) =>
      Effect.gen(function* () {
        const timestamp = DateTime.toEpochMillis(event.data.timestamp)
        const updated = yield* db
          .update(ModelCallTable)
          .set({ delivered_at: timestamp, time_updated: timestamp })
          .where(
            and(
              eq(ModelCallTable.id, event.data.callID),
              eq(ModelCallTable.background, true),
              isNull(ModelCallTable.delivered_at),
            ),
          )
          .returning({ id: ModelCallTable.id })
          .get()
          .pipe(Effect.orDie)
        if (!updated) return yield* Effect.die(new TransitionLost())
      }),
    )

    const finishReservation = Effect.fn("ModelCall.finishReservation")(function* (record: Info) {
      if (isTerminal(record.status) || record.slot !== undefined || record.status !== "preparing") return record
      if (record.depth > 2)
        return yield* transition(
          record.id,
          events.publish(
            ModelCall.Event.Failed,
            {
              timestamp: yield* DateTime.now,
              callID: record.id,
              error: {
                code: "depth_limit",
                message: "Model calls are limited to depth two",
              },
            },
            { location: record.location },
          ),
        ).pipe(Effect.orDie)
      for (const slot of Array.from({ length: ModelCall.MAX_ACTIVE_CHILDREN }, (_, slot) => slot)) {
        const prepared = yield* events
          .publish(
            ModelCall.Event.Prepared,
            {
              timestamp: yield* DateTime.now,
              callID: record.id,
              childSessionID: record.childSessionID,
              childPromptID: record.childPromptID,
              completionMessageID: record.completionMessageID,
              agent: record.agent,
              actualModel: record.actualModel,
              location: record.location,
              runtime: record.runtime,
              depth: record.depth,
              slot,
            },
            { location: record.location },
          )
          .pipe(
            Effect.as(true),
            Effect.catchDefect((defect) =>
              defect instanceof SlotTaken || defect instanceof TransitionLost
                ? Effect.succeed(false)
                : Effect.die(defect),
            ),
          )
        if (prepared) return yield* get(record.id).pipe(Effect.orDie)
        const current = yield* get(record.id).pipe(Effect.orDie)
        if (current.slot !== undefined || current.status !== "preparing") return current
      }
      const current = yield* get(record.id).pipe(Effect.orDie)
      if (current.slot !== undefined || current.status !== "preparing") return current
      return yield* transition(
        record.id,
        events.publish(
          ModelCall.Event.Failed,
          {
            timestamp: yield* DateTime.now,
            callID: record.id,
            error: {
              code: "child_limit",
              message: `A Session can have at most ${ModelCall.MAX_ACTIVE_CHILDREN} active direct model-call children`,
            },
          },
          { location: record.location },
        ),
      ).pipe(Effect.orDie)
    })

    const reserve: Interface["reserve"] = Effect.fn("ModelCall.reserve")(function* (input) {
      if (input.permission.version !== input.runtime)
        return yield* new PermissionSnapshotMismatchError({
          runtime: input.runtime,
          version: input.permission.version,
        })
      const existing = yield* findInvocation(input)
      if (existing) {
        if (matches(existing, input)) return yield* finishReservation(existing)
        return yield* new InvocationConflictError(input)
      }
      const depth = (yield* sessionDepth(db, input.parentSessionID)) + 1
      const callID = ModelCall.CallID.create()
      const childSessionID = Session.ID.create()
      const childPromptID = SessionMessage.ID.create()
      const correctionPromptID = SessionMessage.ID.create()
      const completionMessageID = SessionMessage.ID.create()
      const timestamp = yield* DateTime.now
      const requested = events
        .publish(
          ModelCall.Event.Requested,
          {
            timestamp,
            callID,
            origin: {
              type: "model_call",
              callID,
              parentSessionID: input.parentSessionID,
              parentAssistantMessageID: input.parentAssistantMessageID,
              parentToolCallID: input.parentToolCallID,
              requestedModel: input.requestedModel,
              ...(input.outputSchema === undefined ? {} : { outputSchema: input.outputSchema }),
            },
            requestedModel: input.requestedModel,
            prompt: input.prompt,
            ...(input.system === undefined ? {} : { system: input.system }),
            background: input.background,
            ...(input.outputSchema === undefined ? {} : { output_schema: input.outputSchema }),
            childSessionID,
            childPromptID,
            correctionPromptID,
            completionMessageID,
            agent: input.agent,
            actualModel: input.actualModel,
            location: input.location,
            permission: input.permission,
            runtime: input.runtime,
            depth,
          },
          { location: input.location },
        )
        .pipe(Effect.catchDefect((defect) => (defect instanceof InvocationExists ? Effect.void : Effect.die(defect))))
      yield* requested
      const record = yield* findInvocation(input)
      if (!record) return yield* Effect.die("Model call request was not projected")
      if (record.id !== callID) {
        if (matches(record, input)) return yield* finishReservation(record)
        return yield* new InvocationConflictError(input)
      }
      return yield* finishReservation(record)
    })

    return Service.of({
      reserve,
      get,
      find,
      findInvocation,
      list: (parentSessionID) =>
        db
          .select()
          .from(ModelCallTable)
          .where(eq(ModelCallTable.parent_session_id, parentSessionID))
          .orderBy(asc(ModelCallTable.time_created), asc(ModelCallTable.id))
          .all()
          .pipe(
            Effect.orDie,
            Effect.map((rows) => rows.map(fromRow)),
          ),
      recoverable: (runtime) =>
        db
          .select()
          .from(ModelCallTable)
          .where(
            and(
              eq(ModelCallTable.runtime, runtime),
              or(
                inArray(ModelCallTable.status, ["preparing", "queued", "running"]),
                and(eq(ModelCallTable.background, true), isNull(ModelCallTable.delivered_at)),
              ),
            ),
          )
          .orderBy(asc(ModelCallTable.time_created), asc(ModelCallTable.id))
          .all()
          .pipe(
            Effect.orDie,
            Effect.map((rows) => rows.map(fromRow)),
          ),
      queued: (callID) =>
        Effect.gen(function* () {
          const record = yield* get(callID)
          if (record.status !== "preparing") return record
          return yield* transition(
            callID,
            events.publish(
              ModelCall.Event.Queued,
              { timestamp: yield* DateTime.now, callID },
              { location: record.location },
            ),
          )
        }),
      started: (callID) =>
        Effect.gen(function* () {
          const record = yield* get(callID)
          if (record.status === "running" || isTerminal(record.status)) return record
          return yield* transition(
            callID,
            events.publish(
              ModelCall.Event.Started,
              { timestamp: yield* DateTime.now, callID },
              { location: record.location },
            ),
          )
        }),
      completed: (callID, output) =>
        Effect.gen(function* () {
          const record = yield* get(callID)
          if (isTerminal(record.status)) return record
          return yield* transition(
            callID,
            events.publish(
              ModelCall.Event.Completed,
              {
                timestamp: yield* DateTime.now,
                callID,
                text: output.text,
                ...(output.structured === undefined ? {} : { structured: output.structured }),
                usage: output.usage,
              },
              { location: record.location },
            ),
          )
        }),
      failed: (callID, error, output) =>
        Effect.gen(function* () {
          const record = yield* get(callID)
          if (isTerminal(record.status)) return record
          return yield* transition(
            callID,
            events.publish(
              ModelCall.Event.Failed,
              {
                timestamp: yield* DateTime.now,
                callID,
                error,
                ...(output?.text === undefined ? {} : { text: output.text }),
                ...(output?.usage === undefined ? {} : { usage: output.usage }),
              },
              { location: record.location },
            ),
          )
        }),
      cancelled: (callID, options) =>
        Effect.gen(function* () {
          const record = yield* get(callID)
          if (isTerminal(record.status) || (options?.foregroundOnly && record.background)) return record
          return yield* transition(
            callID,
            events.publish(
              ModelCall.Event.Cancelled,
              {
                timestamp: yield* DateTime.now,
                callID,
                ...(options?.foregroundOnly ? { foregroundOnly: true } : {}),
                ...(options?.usage === undefined ? {} : { usage: options.usage }),
              },
              { location: record.location },
            ),
          )
        }),
      interrupted: (callID, usage, error) =>
        Effect.gen(function* () {
          const record = yield* get(callID)
          if (isTerminal(record.status)) return record
          return yield* transition(
            callID,
            events.publish(
              ModelCall.Event.Interrupted,
              {
                timestamp: yield* DateTime.now,
                callID,
                ...(error === undefined ? {} : { error }),
                ...(usage === undefined ? {} : { usage }),
              },
              { location: record.location },
            ),
          )
        }),
      detach: (callID) =>
        Effect.gen(function* () {
          const record = yield* get(callID)
          if (record.background || isTerminal(record.status)) return record
          return yield* transition(
            callID,
            events.publish(
              ModelCall.Event.Detached,
              { timestamp: yield* DateTime.now, callID },
              { location: record.location },
            ),
          )
        }),
      delivered: (callID) =>
        Effect.gen(function* () {
          const record = yield* get(callID)
          if (record.deliveredAt !== undefined || !record.background || !isTerminal(record.status)) return record
          return yield* transition(
            callID,
            events.publish(
              ModelCall.Event.ResultDelivered,
              { timestamp: yield* DateTime.now, callID },
              { location: record.location },
            ),
          )
        }),
      requestCorrection: (callID, validationError) =>
        Effect.gen(function* () {
          const record = yield* get(callID)
          if (isTerminal(record.status)) return record
          return yield* transition(
            callID,
            events.publish(
              ModelCall.Event.CorrectionRequested,
              {
                timestamp: yield* DateTime.now,
                callID,
                correctionPromptID: record.correctionPromptID,
                attempt: record.validationAttempts + 1,
                validationError,
              },
              { location: record.location },
            ),
          )
        }),
    })
  }),
)

function matches(record: Info, input: ReserveInput) {
  return (
    record.parentSessionID === input.parentSessionID &&
    record.parentAssistantMessageID === input.parentAssistantMessageID &&
    record.parentToolCallID === input.parentToolCallID &&
    record.agent === input.agent &&
    record.runtime === input.runtime &&
    record.requestedBackground === input.background &&
    record.prompt === input.prompt &&
    record.system === input.system &&
    isDeepStrictEqual(record.requestedModel, input.requestedModel) &&
    isDeepStrictEqual(record.actualModel, input.actualModel) &&
    isDeepStrictEqual(record.location, input.location) &&
    isDeepStrictEqual(record.permission, input.permission) &&
    isDeepStrictEqual(record.outputSchema, input.outputSchema)
  )
}

const sessionDepth = Effect.fn("ModelCall.sessionDepth")(function* (
  db: Database.Interface["db"],
  sessionID: Session.ID,
) {
  const visited = new Set<Session.ID>()
  const walk = (current: Session.ID): Effect.Effect<number> =>
    Effect.gen(function* () {
      if (visited.has(current)) return 0
      visited.add(current)
      const call = yield* db
        .select({ depth: ModelCallTable.depth })
        .from(ModelCallTable)
        .where(eq(ModelCallTable.child_session_id, current))
        .get()
        .pipe(Effect.orDie)
      if (call) return call.depth
      const session = yield* db
        .select({ parentID: SessionTable.parent_id })
        .from(SessionTable)
        .where(eq(SessionTable.id, current))
        .get()
        .pipe(Effect.orDie)
      if (!session?.parentID) return 0
      return yield* walk(session.parentID)
    })
  return yield* walk(sessionID)
})

function projectStatus(
  db: Database.Interface["db"],
  callID: ModelCall.CallID,
  from: ReadonlyArray<ModelCall.Status>,
  status: ModelCall.Status,
  timestamp: DateTime.Utc,
  values: Partial<typeof ModelCallTable.$inferInsert>,
  condition?: SQL,
) {
  return Effect.gen(function* () {
    const current = yield* db
      .select({ status: ModelCallTable.status })
      .from(ModelCallTable)
      .where(eq(ModelCallTable.id, callID))
      .get()
      .pipe(Effect.orDie)
    if (!current || !from.includes(current.status)) return yield* Effect.die(new TransitionLost())
    const updated = yield* db
      .update(ModelCallTable)
      .set({
        ...values,
        status,
        time_updated: DateTime.toEpochMillis(timestamp),
      })
      .where(and(eq(ModelCallTable.id, callID), eq(ModelCallTable.status, current.status), condition))
      .returning({ id: ModelCallTable.id })
      .get()
      .pipe(Effect.orDie)
    if (!updated) return yield* Effect.die(new TransitionLost())
  })
}

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Database.node, EventV2.node],
})
