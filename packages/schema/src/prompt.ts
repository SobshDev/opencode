import { Schema } from "effect"
import { ModelCall } from "./model-call"
import { Team } from "./team"
import { SessionID } from "./session-id"
import { optional } from "./schema"
import { statics } from "./schema"

export interface Source extends Schema.Schema.Type<typeof Source> {}
export const Source = Schema.Struct({
  start: Schema.Finite,
  end: Schema.Finite,
  text: Schema.String,
}).annotate({ identifier: "Prompt.Source" })

export interface FileAttachment extends Schema.Schema.Type<typeof FileAttachment> {}
export const FileAttachment = Schema.Struct({
  uri: Schema.String,
  mime: Schema.String,
  name: Schema.String.pipe(optional),
  description: Schema.String.pipe(optional),
  source: Source.pipe(optional),
})
  .annotate({ identifier: "Prompt.FileAttachment" })
  .pipe(
    statics((schema) => ({
      create: (input: FileAttachment) =>
        schema.make({
          uri: input.uri,
          mime: input.mime,
          name: input.name,
          description: input.description,
          source: input.source,
        }),
    })),
  )

export interface AgentAttachment extends Schema.Schema.Type<typeof AgentAttachment> {}
export const AgentAttachment = Schema.Struct({
  name: Schema.String,
  source: Source.pipe(optional),
}).annotate({ identifier: "Prompt.AgentAttachment" })

export interface ModelCallResult extends Schema.Schema.Type<typeof ModelCallResult> {}
export const ModelCallResult = Schema.Struct({
  type: Schema.Literal("model-call-result"),
  result: Schema.suspend(() => ModelCall.CallResult),
}).annotate({ identifier: "Prompt.ModelCallResult" })

export interface TeamMessage extends Schema.Schema.Type<typeof TeamMessage> {}
export const TeamMessage = Schema.Struct({
  type: Schema.Literal("team-message"),
  messageID: Team.MessageID,
  teamID: Team.ID,
  senderMemberID: Team.MemberID,
  senderSessionID: SessionID,
  body: Schema.String,
}).annotate({ identifier: "Prompt.TeamMessage" })

export const Internal = Schema.Union([ModelCallResult, TeamMessage]).pipe(Schema.toTaggedUnion("type"))
export type Internal = ModelCallResult | TeamMessage

export interface Prompt extends Schema.Schema.Type<typeof Prompt> {}
export const Prompt = Schema.Struct({
  text: Schema.String,
  files: Schema.Array(FileAttachment).pipe(optional),
  agents: Schema.Array(AgentAttachment).pipe(optional),
  internal: Internal.pipe(optional),
})
  .annotate({ identifier: "Prompt" })
  .pipe(
    statics((schema) => ({
      equivalence: Schema.toEquivalence(schema),
      fromUserMessage: (input: Pick<Prompt, "text" | "files" | "agents">) =>
        schema.make({
          text: input.text,
          ...(input.files === undefined ? {} : { files: input.files }),
          ...(input.agents === undefined ? {} : { agents: input.agents }),
        }),
    })),
  )
