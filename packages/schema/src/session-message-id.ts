import { Schema } from "effect"
import { ascending } from "./identifier"
import { statics } from "./schema"

export const SessionMessageID = Schema.String.check(Schema.isStartsWith("msg_")).pipe(
  Schema.brand("Session.Message.ID"),
  statics((schema) => ({ create: () => schema.make("msg_" + ascending()) })),
)
export type SessionMessageID = typeof SessionMessageID.Type
