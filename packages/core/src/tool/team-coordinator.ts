import { ToolFailure } from "@opencode-ai/llm"
import { Effect } from "effect"
import { SessionSchema } from "../session/schema"
import { TeamV2 } from "../team"

export const assertTeamCoordinatorReadOnly = Effect.fn("Tool.assertTeamCoordinatorReadOnly")(function* (
  teams: TeamV2.Interface,
  sessionID: SessionSchema.ID,
) {
  const team = yield* teams.findByLead(sessionID)
  if (!team || !["preparing", "active", "degraded", "shutting_down"].includes(team.status)) return
  yield* new ToolFailure({
    message: "The Team lead is coordinator-only while its Team is active. Delegate writes to a teammate worktree.",
  })
})

export const assertTeamCoordinatorCommand = Effect.fn("Tool.assertTeamCoordinatorCommand")(function* (
  teams: TeamV2.Interface,
  sessionID: SessionSchema.ID,
  command: string,
) {
  const team = yield* teams.findByLead(sessionID)
  if (!team || !["preparing", "active", "degraded", "shutting_down"].includes(team.status)) return
  if (readOnlyCommand(command)) return
  yield* new ToolFailure({
    message:
      "The Team lead is coordinator-only while its Team is active. Bash is limited to simple read-only inspection commands; delegate mutations to a teammate worktree.",
  })
})

function readOnlyCommand(command: string) {
  if (!command.trim() || /[\n\r;&|><`$(){}]/.test(command)) return false
  const tokens = command.trim().split(/\s+/)
  const executable = tokens[0]?.replace(/^['"]|['"]$/g, "")
  if (!executable || executable.includes("/") || executable.includes("\\")) return false
  if (executable === "pwd") return tokens.length === 1
  if (executable === "ls" || executable === "stat" || executable === "wc") return true
  if (executable !== "git") return false
  const args = tokens.slice(1)
  const offset = args[0] === "--no-pager" ? 1 : 0
  const subcommand = args[offset]
  const options = args.slice(offset + 1)
  if (subcommand === "status" || subcommand === "rev-parse") return true
  if (subcommand === "branch") return options.every((option) => option === "--show-current" || option === "--no-color")
  if (subcommand === "diff" || subcommand === "show" || subcommand === "log") {
    if (
      options.some(
        (option) =>
          option === "--output" ||
          option.startsWith("--output=") ||
          option === "-o" ||
          option === "--ext-diff" ||
          option === "--textconv",
      )
    )
      return false
    return options.includes("--no-ext-diff") && options.includes("--no-textconv")
  }
  return false
}
