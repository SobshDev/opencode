export * as ModelCall from "./model-call"

import { Schema } from "effect"
import { Agent } from "./agent"
import { define, inventory } from "./event"
import { ascending } from "./identifier"
import { Location } from "./location"
import { Model } from "./model"
import { Permission } from "./permission"
import { Provider } from "./provider"
import { DateTimeUtcFromMillis, NonNegativeInt, PositiveInt, optional, statics } from "./schema"
import { SessionID } from "./session-id"
import { SessionMessageID } from "./session-message-id"
import { PermissionV1 } from "./v1/permission"

export const CallID = Schema.String.check(Schema.isStartsWith("mcl_")).pipe(
  Schema.brand("ModelCall.CallID"),
  statics((schema) => ({ create: () => schema.make("mcl_" + ascending()) })),
)
export type CallID = typeof CallID.Type

export const Status = Schema.Literals([
  "preparing",
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]).annotate({ identifier: "ModelCall.Status" })
export type Status = typeof Status.Type

export const Mode = Schema.Literals(["foreground", "background"]).annotate({ identifier: "ModelCall.Mode" })
export type Mode = typeof Mode.Type

export interface Error extends Schema.Schema.Type<typeof Error> {}
export const Error = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
  outcomeUnknown: Schema.Boolean.pipe(optional),
}).annotate({ identifier: "ModelCall.Error" })

export interface Usage extends Schema.Schema.Type<typeof Usage> {}
export const Usage = Schema.Struct({
  cost: Schema.Finite,
  tokens: Schema.Struct({
    input: Schema.Finite,
    output: Schema.Finite,
    reasoning: Schema.Finite,
    cache: Schema.Struct({
      read: Schema.Finite,
      write: Schema.Finite,
    }),
  }),
}).annotate({ identifier: "ModelCall.Usage" })

export const PermissionSnapshot = Schema.Union([
  Schema.Struct({
    version: Schema.Literal("legacy"),
    rules: PermissionV1.Ruleset,
  }),
  Schema.Struct({
    version: Schema.Literal("v2"),
    rules: Permission.Ruleset,
  }),
])
  .pipe(Schema.toTaggedUnion("version"))
  .annotate({ identifier: "ModelCall.PermissionSnapshot" })
export type PermissionSnapshot = typeof PermissionSnapshot.Type

export interface Origin extends Schema.Schema.Type<typeof Origin> {}
export const Origin = Schema.Struct({
  type: Schema.Literal("model_call"),
  callID: CallID,
  parentSessionID: SessionID,
  parentAssistantMessageID: SessionMessageID,
  parentToolCallID: Schema.String,
  requestedModel: Model.Ref,
  outputSchema: Schema.Record(Schema.String, Schema.Unknown).pipe(optional),
}).annotate({ identifier: "ModelCall.Origin" })

export interface CallableModel extends Schema.Schema.Type<typeof CallableModel> {}
export const CallableModel = Schema.Struct({
  ref: Model.Ref,
  name: Schema.String,
  description: Schema.String.pipe(optional),
  family: Model.Family.pipe(optional),
  capabilities: Model.Capabilities,
  variants: Schema.Array(Model.VariantID),
  status: Model.Info.fields.status,
  limits: Model.Info.fields.limit,
  cost: Schema.Array(Model.Cost),
}).annotate({ identifier: "ModelCall.CallableModel" })

export const MAX_LIST_LIMIT = 50
export const MAX_ACTIVE_CHILDREN = 20

export interface ListInput extends Schema.Schema.Type<typeof ListInput> {}
export const ListInput = Schema.Struct({
  query: Schema.String.pipe(optional),
  providerID: Provider.ID.pipe(optional),
  tools: Schema.Boolean.pipe(optional),
  limit: PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_LIST_LIMIT)).pipe(optional),
  cursor: Schema.String.check(Schema.isPattern(/^model:\d+$/)).pipe(optional),
}).annotate({ identifier: "ModelCall.ListInput" })

export interface ListResult extends Schema.Schema.Type<typeof ListResult> {}
export const ListResult = Schema.Struct({
  items: Schema.Array(CallableModel),
  nextCursor: Schema.String.pipe(optional),
}).annotate({ identifier: "ModelCall.ListResult" })

export interface CallInput extends Schema.Schema.Type<typeof CallInput> {}
export const CallInput = Schema.Struct({
  model: Model.Ref,
  prompt: Schema.String,
  background: Schema.Boolean.pipe(optional),
  output_schema: Schema.Record(Schema.String, Schema.Unknown).pipe(optional),
}).annotate({ identifier: "ModelCall.CallInput" })

export interface CallResult extends Schema.Schema.Type<typeof CallResult> {}
export const CallResult = Schema.Struct({
  callID: CallID,
  parentSessionID: SessionID,
  childSessionID: SessionID,
  requestedModel: Model.Ref,
  actualModel: Model.Ref,
  mode: Mode,
  status: Status,
  text: Schema.String.pipe(optional),
  structured: Schema.Unknown.pipe(optional),
  error: Error.pipe(optional),
  usage: Usage.pipe(optional),
}).annotate({ identifier: "ModelCall.CallResult" })

export namespace Event {
  const options = {
    durable: {
      aggregate: "callID",
      version: 1,
    },
  } as const
  const Base = {
    timestamp: DateTimeUtcFromMillis,
    callID: CallID,
  }

  export const Requested = define({
    type: "model.call.requested",
    ...options,
    schema: {
      ...Base,
      origin: Origin,
      requestedModel: Model.Ref,
      prompt: Schema.String,
      system: Schema.String.pipe(optional),
      background: Schema.Boolean,
      output_schema: Schema.Record(Schema.String, Schema.Unknown).pipe(optional),
      childSessionID: SessionID,
      childPromptID: SessionMessageID,
      correctionPromptID: SessionMessageID,
      completionMessageID: SessionMessageID,
      agent: Agent.ID,
      actualModel: Model.Ref,
      location: Location.Ref,
      permission: PermissionSnapshot,
      runtime: Schema.Literals(["legacy", "v2"]),
      depth: NonNegativeInt,
    },
  })
  export type Requested = typeof Requested.Type

  export const Prepared = define({
    type: "model.call.prepared",
    ...options,
    schema: {
      ...Base,
      childSessionID: SessionID,
      childPromptID: SessionMessageID,
      completionMessageID: SessionMessageID,
      agent: Agent.ID,
      actualModel: Model.Ref,
      location: Location.Ref,
      runtime: Schema.Literals(["legacy", "v2"]),
      depth: NonNegativeInt,
      slot: NonNegativeInt.check(Schema.isLessThanOrEqualTo(MAX_ACTIVE_CHILDREN - 1)),
    },
  })
  export type Prepared = typeof Prepared.Type

  export const Queued = define({
    type: "model.call.queued",
    ...options,
    schema: Base,
  })
  export type Queued = typeof Queued.Type

  export const Started = define({
    type: "model.call.started",
    ...options,
    schema: Base,
  })
  export type Started = typeof Started.Type

  export const CorrectionRequested = define({
    type: "model.call.correction-requested",
    ...options,
    schema: {
      ...Base,
      correctionPromptID: SessionMessageID,
      attempt: PositiveInt,
      validationError: Schema.String,
    },
  })
  export type CorrectionRequested = typeof CorrectionRequested.Type

  export const Completed = define({
    type: "model.call.completed",
    ...options,
    schema: {
      ...Base,
      text: Schema.String,
      structured: Schema.Unknown.pipe(optional),
      usage: Usage,
    },
  })
  export type Completed = typeof Completed.Type

  export const Failed = define({
    type: "model.call.failed",
    ...options,
    schema: {
      ...Base,
      error: Error,
      text: Schema.String.pipe(optional),
      usage: Usage.pipe(optional),
    },
  })
  export type Failed = typeof Failed.Type

  export const Cancelled = define({
    type: "model.call.cancelled",
    ...options,
    schema: {
      ...Base,
      foregroundOnly: Schema.Boolean.pipe(optional),
      usage: Usage.pipe(optional),
    },
  })
  export type Cancelled = typeof Cancelled.Type

  export const Interrupted = define({
    type: "model.call.interrupted",
    ...options,
    schema: {
      ...Base,
      error: Error.pipe(optional),
      usage: Usage.pipe(optional),
    },
  })
  export type Interrupted = typeof Interrupted.Type

  export const Detached = define({
    type: "model.call.detached",
    ...options,
    schema: Base,
  })
  export type Detached = typeof Detached.Type

  export const ResultDelivered = define({
    type: "model.call.result-delivered",
    ...options,
    schema: Base,
  })
  export type ResultDelivered = typeof ResultDelivered.Type

  export const DurableDefinitions = inventory(
    Requested,
    Prepared,
    Queued,
    Started,
    CorrectionRequested,
    Completed,
    Failed,
    Cancelled,
    Interrupted,
    Detached,
    ResultDelivered,
  )
  export const Definitions = DurableDefinitions

  export const Durable = Schema.Union(DurableDefinitions, { mode: "oneOf" })
    .pipe(Schema.toTaggedUnion("type"))
    .annotate({ identifier: "ModelCall.DurableEvent" })
  export type Durable = typeof Durable.Type

  export const All = Durable
  export type Event = Durable
  export type Type = Event["type"]
}
