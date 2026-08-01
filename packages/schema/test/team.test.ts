import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Team } from "../src/team"
import { SessionOrigin } from "../src/session-origin"
import { Prompt } from "../src/prompt"

describe("Team contracts", () => {
  test("uses exact branded ID prefixes", () => {
    expect(Team.ID.create()).toStartWith("tem_")
    expect(Team.MemberID.create()).toStartWith("mem_")
    expect(Team.MessageID.create()).toStartWith("tmg_")
    expect(Team.TaskID.create()).toStartWith("ttk_")
    expect(Team.WorkspaceID.create()).toStartWith("tws_")
    expect(Team.SubmissionID.create()).toStartWith("sub_")
    expect(() => Schema.decodeUnknownSync(Team.ID)("tem_valid")).not.toThrow()
    expect(() => Schema.decodeUnknownSync(Team.ID)("tem-invalid")).toThrow()
  })

  test("bounds spawn size and validates teammate names", () => {
    const member = {
      name: "writer",
      model: { providerID: "anthropic", id: "claude" },
      prompt: "Implement the feature",
    }
    expect(() => Schema.decodeUnknownSync(Team.SpawnInput)({ members: [] })).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(Team.SpawnInput)({
        members: Array.from({ length: Team.MAX_MEMBERS + 1 }, (_, index) => ({ ...member, name: `writer-${index}` })),
      }),
    ).toThrow()
    expect(() => Schema.decodeUnknownSync(Team.SpawnInput)({ members: [member] })).not.toThrow()
    expect(() => Schema.decodeUnknownSync(Team.SpawnInput)({ members: [{ ...member, name: "lead" }] })).toThrow()
  })

  test("preserves trusted teammate origin and message provenance", () => {
    const teamID = Team.ID.create()
    const memberID = Team.MemberID.create()
    const origin = Schema.decodeUnknownSync(SessionOrigin.Origin)({
      type: "team_member",
      teamID,
      memberID,
      leadSessionID: "ses_team_lead",
      parentAssistantMessageID: "msg_team_parent",
      parentToolCallID: "tool-team",
    })
    expect(origin.type).toBe("team_member")

    const prompt = Schema.decodeUnknownSync(Prompt)({
      text: "<team_message>review this</team_message>",
      internal: {
        type: "team-message",
        messageID: Team.MessageID.create(),
        teamID,
        senderMemberID: memberID,
        senderSessionID: "ses_team_member",
        body: "review this",
      },
    })
    expect(prompt.internal?.type).toBe("team-message")
  })
})
