export * as SessionOrigin from "./session-origin"

import { Schema } from "effect"
import { ModelCall } from "./model-call"
import { Team } from "./team"

export const Origin = Schema.Union([ModelCall.Origin, Team.Origin])
  .pipe(Schema.toTaggedUnion("type"))
  .annotate({ identifier: "Session.Origin" })
export type Origin = typeof Origin.Type
