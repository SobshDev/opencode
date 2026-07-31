export * as DurableEventManifest from "./durable-event-manifest"

import { Event } from "./event"
import { ModelCall } from "./model-call"
import { SessionEvent } from "./session-event"
import { SessionV1 } from "./session-v1"

export const SessionDurable = {
  definitions: Event.durable(SessionEvent.DurableDefinitions),
  schema: SessionEvent.Durable,
} as const

export const ModelCallDurable = {
  definitions: Event.durable(ModelCall.Event.DurableDefinitions),
  schema: ModelCall.Event.Durable,
} as const

export const Durable = Event.durable([
  ...SessionV1.Event.Definitions.filter((definition) => definition.durable !== undefined),
  ...SessionEvent.DurableDefinitions,
  ...ModelCall.Event.DurableDefinitions,
])
