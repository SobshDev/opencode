export * as TeamWorkspace from "./workspace"

import path from "path"
import { Team } from "@opencode-ai/schema/team"
import { ChildProcess } from "effect/unstable/process"
import { Context, Effect, Layer, Schema } from "effect"
import { FSUtil } from "../fs-util"
import { Git } from "../git"
import { Global } from "../global"
import { AppProcess } from "../process"
import { AbsolutePath } from "../schema"
import { TeamV2 } from "../team"
import { makeGlobalNode } from "../effect/app-node"
import { KeyedMutex } from "../effect/keyed-mutex"

export type Preflight = {
  readonly repository: Git.Repository
  readonly branch: string
  readonly commit: string
  readonly root: AbsolutePath
}

export class WorkspaceError extends Schema.TaggedErrorClass<WorkspaceError>()("Team.WorkspaceError", {
  operation: Schema.Literals(["preflight", "provision", "capture", "merge", "validate", "apply", "sync", "cleanup"]),
  message: Schema.String,
  directory: Schema.String.pipe(Schema.optional),
}) {}

export interface Interface {
  readonly root: AbsolutePath
  readonly withLock: <A, E, R>(teamID: Team.ID, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  readonly withCoordinationLock: <A, E, R>(teamID: Team.ID, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  readonly preflight: (directory: AbsolutePath) => Effect.Effect<Preflight, WorkspaceError>
  readonly initialize: (team: Team.Info) => Effect.Effect<void, WorkspaceError>
  readonly provision: (team: Team.Info, member: TeamV2.ReservedMember) => Effect.Effect<Git.Repository, WorkspaceError>
  readonly submit: (
    submission: Team.Submission,
    actor: TeamV2.Caller,
  ) => Effect.Effect<Team.Submission, WorkspaceError | TeamV2.NotFoundError>
  readonly apply: (submission: Team.Submission) => Effect.Effect<Team.Submission, WorkspaceError | TeamV2.NotFoundError>
  readonly applyLocked: (
    submission: Team.Submission,
  ) => Effect.Effect<Team.Submission, WorkspaceError | TeamV2.NotFoundError>
  readonly sync: (actor: TeamV2.Caller) => Effect.Effect<Team.SyncResult, WorkspaceError | TeamV2.NotFoundError>
  readonly cleanup: (team: Team.Info, member: Team.Member, force: boolean) => Effect.Effect<void, WorkspaceError>
  readonly close: (
    actor: TeamV2.Caller,
    force: boolean,
  ) => Effect.Effect<Team.Info, WorkspaceError | TeamV2.NotFoundError | TeamV2.InvalidStateError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/TeamWorkspace") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const git = yield* Git.Service
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const appProcess = yield* AppProcess.Service
    const teams = yield* TeamV2.Service
    const locks = KeyedMutex.makeUnsafe<Team.ID>()
    const coordinationLocks = KeyedMutex.makeUnsafe<Team.ID>()
    const root = AbsolutePath.make(path.join(global.data, "team-worktrees"))
    const withLock: Interface["withLock"] = (teamID, effect) => locks.withLock(teamID)(effect)
    const withCoordinationLock: Interface["withCoordinationLock"] = (teamID, effect) =>
      coordinationLocks.withLock(teamID)(effect)

    const repository = Effect.fnUntraced(function* (directory: string, operation: WorkspaceError["operation"]) {
      const found = yield* git.repo.discover(AbsolutePath.make(directory))
      if (found) return found
      return yield* new WorkspaceError({ operation, directory, message: "Git repository not found" })
    })

    const preflight = Effect.fn("TeamWorkspace.preflight")(function* (directory: AbsolutePath) {
      const repo = yield* repository(directory, "preflight")
      const [clean, branch, commit] = yield* Effect.all(
        [git.history.clean(repo), git.history.branch(repo), git.history.head(repo)],
        { concurrency: 3 },
      ).pipe(
        Effect.mapError((error) => new WorkspaceError({ operation: "preflight", directory, message: error.message })),
      )
      if (!clean)
        return yield* new WorkspaceError({
          operation: "preflight",
          directory: repo.worktree,
          message: "Team spawning requires a clean working tree and index",
        })
      if (!branch)
        return yield* new WorkspaceError({
          operation: "preflight",
          directory: repo.worktree,
          message: "Team spawning requires a named local branch",
        })
      if (!commit)
        return yield* new WorkspaceError({
          operation: "preflight",
          directory: repo.worktree,
          message: "Team spawning requires an existing HEAD commit",
        })
      return { repository: repo, branch, commit, root: repo.worktree }
    })

    const initialize = Effect.fn("TeamWorkspace.initialize")(function* (team: Team.Info) {
      const target = yield* repository(team.location.directory, "provision")
      yield* fs
        .makeDirectory(root, { recursive: true })
        .pipe(
          Effect.mapError(
            (error) => new WorkspaceError({ operation: "provision", directory: root, message: error.message }),
          ),
        )
      yield* git.collaboration
        .updateRef({ repository: target, ref: integrationRef(team.id), commit: team.integrationCommit })
        .pipe(
          Effect.mapError(
            (error) =>
              new WorkspaceError({ operation: "provision", directory: target.worktree, message: error.message }),
          ),
        )
    })

    const provision = Effect.fn("TeamWorkspace.provision")(function* (team: Team.Info, member: TeamV2.ReservedMember) {
      const existing = yield* git.repo.discover(AbsolutePath.make(member.directory))
      if (existing) {
        const branch = yield* git.history.branch(existing)
        if (branch === member.branch) return existing
        return yield* new WorkspaceError({
          operation: "provision",
          directory: member.directory,
          message: `Existing worktree uses branch ${branch ?? "detached"}, expected ${member.branch}`,
        })
      }
      if (yield* fs.existsSafe(member.directory))
        return yield* new WorkspaceError({
          operation: "provision",
          directory: member.directory,
          message: "Existing directory is not the reserved Git worktree",
        })
      const target = yield* repository(team.location.directory, "provision")
      yield* git.worktree
        .remove({ repository: target, directory: AbsolutePath.make(member.directory), force: true })
        .pipe(Effect.catch(() => Effect.void))
      yield* fs
        .makeDirectory(path.dirname(member.directory), { recursive: true })
        .pipe(
          Effect.mapError(
            (error) =>
              new WorkspaceError({ operation: "provision", directory: member.directory, message: error.message }),
          ),
        )
      return yield* git.worktree
        .create({
          repository: target,
          directory: AbsolutePath.make(member.directory),
          revision: team.baseCommit,
          branch: member.branch,
        })
        .pipe(
          Effect.catchTag("Git.WorktreeError", () =>
            git.worktree.create({
              repository: target,
              directory: AbsolutePath.make(member.directory),
              branch: member.branch,
              reuseBranch: true,
            }),
          ),
          Effect.mapError(
            (error) =>
              new WorkspaceError({ operation: "provision", directory: member.directory, message: error.message }),
          ),
        )
    })

    const submit = Effect.fn("TeamWorkspace.submit")((submission: Team.Submission, actor: TeamV2.Caller) =>
      withLock(
        actor.team.id,
        Effect.gen(function* () {
          if (!actor.member)
            return yield* new WorkspaceError({ operation: "capture", message: "Lead Sessions cannot submit changes" })
          const current = yield* teams.submission(submission.id)
          if (!["preparing", "queued", "merging", "validating"].includes(current.status)) return current
          const team = yield* teams.get(actor.team.id)
          const member = team.members.find((item) => item.id === actor.memberID && item.sessionID === actor.sessionID)
          if (
            (team.status !== "active" && team.status !== "degraded") ||
            !member ||
            (member.status !== "running" && member.status !== "idle")
          )
            return (
              (yield* teams.transitionSubmission({
                submissionID: current.id,
                from: ["preparing", "queued", "merging", "validating"],
                to: "cancelled",
                values: { error: "Team or teammate stopped before submission staged" },
              })) ?? (yield* teams.submission(current.id))
            )
          const source = yield* repository(member.directory, "capture")
          const prepared = yield* current.status === "preparing"
            ? Effect.gen(function* () {
                const capture = yield* git.collaboration
                  .captureCommit({
                    repository: source,
                    message: `team(${actor.name}): submit ${current.taskID}`,
                    ref: submissionRef(team.id, current.id),
                  })
                  .pipe(
                    Effect.mapError(
                      (error) =>
                        new WorkspaceError({
                          operation: "capture",
                          directory: source.worktree,
                          message: error.message,
                        }),
                    ),
                  )
                if (!capture.changed) {
                  yield* teams.memberIntegrated(actor.memberID, team.integrationCommit)
                  return yield* teams.submissionStatus(current.id, "applied", {
                    resultCommit: team.integrationCommit,
                    validationOutput: "No workspace changes to integrate.",
                  })
                }
                const queued = yield* teams.submissionStatus(current.id, "queued", {
                  sourceCommit: capture.commit,
                  expectedIntegrationCommit: team.integrationCommit,
                })
                return queued
              })
            : Effect.succeed(current)
          if (prepared.status === "applied" || !prepared.sourceCommit) return prepared
          const captured = yield* git.collaboration
            .matchesCommit({ repository: source, commit: prepared.sourceCommit })
            .pipe(
              Effect.mapError(
                (error) =>
                  new WorkspaceError({ operation: "capture", directory: source.worktree, message: error.message }),
              ),
            )
          if (captured)
            yield* git.collaboration
              .adopt({ repository: source, commit: prepared.sourceCommit })
              .pipe(
                Effect.mapError(
                  (error) =>
                    new WorkspaceError({ operation: "capture", directory: source.worktree, message: error.message }),
                ),
              )
          const refreshed = yield* teams.get(team.id)
          if (
            refreshed.integrationCommit !== prepared.expectedIntegrationCommit &&
            refreshed.integrationCommit !== prepared.resultCommit
          )
            return yield* teams.submissionStatus(prepared.id, "stale", {
              error: "Integration head advanced before this submission could resume",
            })
          if (prepared.resultCommit === refreshed.integrationCommit && prepared.validationOutput !== undefined) {
            const target = yield* repository(refreshed.location.directory, "apply")
            yield* git.collaboration
              .updateRef({
                repository: target,
                ref: integrationRef(refreshed.id),
                commit: refreshed.integrationCommit,
              })
              .pipe(
                Effect.catch((error) =>
                  Effect.logWarning("Failed to repair Team integration ref", {
                    teamID: refreshed.id,
                    submissionID: prepared.id,
                    error,
                  }),
                ),
              )
            return yield* teams.submissionStatus(prepared.id, "ready", { error: null })
          }
          return yield* stage(prepared, actor, refreshed, prepared.sourceCommit)
        }),
      ).pipe(
        Effect.catch((error) =>
          teams
            .transitionSubmission({
              submissionID: submission.id,
              from: ["preparing", "queued", "merging", "validating"],
              to: "failed",
              values: { error: error instanceof Error ? error.message : String(error) },
            })
            .pipe(Effect.andThen(Effect.fail(error))),
        ),
      ),
    )

    const stage = Effect.fn("TeamWorkspace.stage")(function* (
      submission: Team.Submission,
      actor: TeamV2.Caller,
      team: Team.Info,
      sourceCommit: string,
    ) {
      const directory = AbsolutePath.make(path.join(root, team.id.slice(-12), ".integration", submission.id.slice(-12)))
      const target = yield* repository(team.location.directory, "merge")
      yield* git.worktree
        .remove({ repository: target, directory, force: true })
        .pipe(Effect.catch(() => fs.remove(directory, { recursive: true, force: true }).pipe(Effect.ignore)))
      yield* fs
        .makeDirectory(path.dirname(directory), { recursive: true })
        .pipe(Effect.mapError((error) => new WorkspaceError({ operation: "merge", directory, message: error.message })))
      const integration = yield* git.worktree
        .create({ repository: target, directory, revision: team.integrationCommit })
        .pipe(Effect.mapError((error) => new WorkspaceError({ operation: "merge", directory, message: error.message })))
      return yield* Effect.gen(function* () {
        yield* teams.submissionStatus(submission.id, "merging")
        const merged = yield* git.collaboration
          .merge({
            repository: integration,
            sourceCommit,
            message: `merge(team): ${actor.name} ${submission.taskID}`,
          })
          .pipe(
            Effect.mapError((error) => new WorkspaceError({ operation: "merge", directory, message: error.message })),
          )
        if (merged.conflicts.length)
          return yield* teams.submissionStatus(submission.id, "conflicted", {
            conflicts: merged.conflicts,
            error: "Submission conflicts with the current integration head",
          })
        if (!merged.commit)
          return yield* new WorkspaceError({ operation: "merge", directory, message: "Merge produced no commit" })
        const resultCommit = merged.commit
        yield* teams.submissionStatus(submission.id, "validating", { resultCommit })
        const validation = yield* validate(integration.worktree, team.validation)
        if (!validation.success)
          return yield* teams.submissionStatus(submission.id, "validation_failed", {
            resultCommit,
            validationOutput: validation.output,
            error: "Integration validation failed",
          })
        yield* teams.submissionStatus(submission.id, "validating", { validationOutput: validation.output })
        if (!(yield* teams.advanceIntegration(team.id, team.integrationCommit, resultCommit)))
          return yield* teams.submissionStatus(submission.id, "stale", {
            resultCommit,
            validationOutput: validation.output,
            error: "Integration head advanced concurrently",
          })
        yield* git.collaboration
          .updateRef({ repository: target, ref: integrationRef(team.id), commit: resultCommit })
          .pipe(
            Effect.catch((error) =>
              Effect.logWarning("Failed to update Team integration ref", {
                teamID: team.id,
                submissionID: submission.id,
                error,
              }),
            ),
          )
        return yield* teams.submissionStatus(submission.id, "ready", {
          resultCommit,
          validationOutput: validation.output,
          error: null,
        })
      }).pipe(
        Effect.ensuring(
          git.worktree.remove({ repository: target, directory, force: true }).pipe(Effect.catch(() => Effect.void)),
        ),
      )
    })

    const applyLocked = Effect.fn("TeamWorkspace.applyLocked")((submission: Team.Submission) =>
      Effect.gen(function* () {
        const current = yield* teams.submission(submission.id)
        if (current.status === "applied") return current
        if (current.status !== "ready" && current.status !== "applying") return current
        if (!current.resultCommit)
          return yield* new WorkspaceError({ operation: "apply", message: "Submission has no result commit" })
        const resultCommit = current.resultCommit
        const claimed =
          current.status === "ready"
            ? yield* teams.transitionSubmission({
                submissionID: current.id,
                from: ["ready"],
                to: "applying",
                values: { error: null },
              })
            : current
        if (!claimed) return yield* teams.submission(current.id)
        const team = yield* teams.get(current.teamID)
        const member = team.members.find((item) => item.id === current.memberID)
        if (
          (team.status !== "active" && team.status !== "degraded") ||
          !member ||
          (member.status !== "running" && member.status !== "idle")
        )
          return (
            (yield* teams.transitionSubmission({
              submissionID: current.id,
              from: ["applying"],
              to: "cancelled",
              values: { error: "Team or teammate stopped before submission applied" },
            })) ?? (yield* teams.submission(current.id))
          )
        const target = yield* repository(team.location.directory, "apply")
        const contains = (ancestor: string, descendant: string) =>
          git.collaboration
            .isAncestor({ repository: target, ancestor, descendant })
            .pipe(
              Effect.mapError(
                (error) =>
                  new WorkspaceError({ operation: "apply", directory: target.worktree, message: error.message }),
              ),
            )
        const retry = (error: string) =>
          teams
            .transitionSubmission({
              submissionID: current.id,
              from: ["applying"],
              to: "ready",
              values: { error },
            })
            .pipe(Effect.flatMap((result) => (result ? Effect.succeed(result) : teams.submission(current.id))))
        const branch = yield* git.history.branch(target)
        if (branch !== team.targetBranch)
          return yield* retry(`Lead workspace is on ${branch ?? "a detached HEAD"}; expected ${team.targetBranch}`)
        const head = yield* git.history.head(target)
        if (!head)
          return yield* new WorkspaceError({
            operation: "apply",
            directory: target.worktree,
            message: "Missing target HEAD",
          })
        const contained = head === resultCommit || (yield* contains(resultCommit, head))
        if (
          !contained &&
          !(yield* git.history
            .clean(target)
            .pipe(
              Effect.mapError(
                (error) =>
                  new WorkspaceError({ operation: "apply", directory: target.worktree, message: error.message }),
              ),
            ))
        )
          return yield* retry("Lead workspace is dirty; validated integration is waiting to apply")
        if (!contained && !(yield* contains(head, resultCommit))) {
          if (yield* teams.advanceIntegration(team.id, resultCommit, current.expectedIntegrationCommit))
            yield* git.collaboration
              .updateRef({
                repository: target,
                ref: integrationRef(team.id),
                commit: current.expectedIntegrationCommit,
                expected: resultCommit,
              })
              .pipe(
                Effect.catch((error) =>
                  Effect.logWarning("Failed to roll back divergent Team integration ref", {
                    teamID: team.id,
                    submissionID: current.id,
                    error,
                  }),
                ),
              )
          return (
            (yield* teams.transitionSubmission({
              submissionID: current.id,
              from: ["applying"],
              to: "stale",
              values: { error: "Lead branch diverged before validated integration could apply" },
            })) ?? (yield* teams.submission(current.id))
          )
        }
        if (!contained) {
          const applied = yield* git.collaboration
            .applyFastForward({ repository: target, expectedCommit: head, resultCommit })
            .pipe(
              Effect.as(true),
              Effect.catchTag("Git.OperationError", () => Effect.succeed(false)),
            )
          if (!applied) return yield* retry("Lead workspace moved while validated integration was applying")
        }
        return (
          (yield* teams.transitionSubmission({
            submissionID: current.id,
            from: ["applying"],
            to: "applied",
            values: { error: null },
          })) ?? (yield* teams.submission(current.id))
        )
      }).pipe(
        Effect.onInterrupt(() =>
          teams
            .transitionSubmission({
              submissionID: submission.id,
              from: ["applying"],
              to: "ready",
              values: { error: "Lead application was interrupted and remains ready to retry" },
            })
            .pipe(Effect.asVoid),
        ),
      ),
    )

    const apply = (submission: Team.Submission) => withLock(submission.teamID, applyLocked(submission))

    const sync = Effect.fn("TeamWorkspace.sync")((actor: TeamV2.Caller) =>
      withLock(
        actor.team.id,
        Effect.gen(function* () {
          const current = yield* teams
            .caller(actor.sessionID)
            .pipe(Effect.mapError((error) => new WorkspaceError({ operation: "sync", message: error.message })))
          if (!current.member)
            return yield* new WorkspaceError({
              operation: "sync",
              message: "The lead does not have a teammate worktree",
            })
          if (current.member.status !== "running" && current.member.status !== "idle")
            return yield* new WorkspaceError({ operation: "sync", message: `Teammate is ${current.member.status}` })
          if (current.team.status !== "active" && current.team.status !== "degraded")
            return yield* new WorkspaceError({ operation: "sync", message: `Team is ${current.team.status}` })
          const unresolved = (yield* teams.submissions(current.team.id)).some(
            (submission) =>
              submission.memberID === current.memberID &&
              !["applied", "failed", "cancelled"].includes(submission.status),
          )
          const repo = yield* repository(current.member.directory, "sync")
          const result = yield* (
            unresolved
              ? git.collaboration.prepareSync({ repository: repo, commit: current.team.integrationCommit })
              : git.collaboration
                  .sync({ repository: repo, commit: current.team.integrationCommit })
                  .pipe(Effect.as({ conflicts: [] as ReadonlyArray<string> }))
          ).pipe(
            Effect.mapError(
              (error) => new WorkspaceError({ operation: "sync", directory: repo.worktree, message: error.message }),
            ),
          )
          if (!result.conflicts.length) yield* teams.memberIntegrated(current.memberID, current.team.integrationCommit)
          const member = yield* teams.caller(current.sessionID).pipe(
            Effect.flatMap((refreshed) =>
              refreshed.member
                ? Effect.succeed(refreshed.member)
                : Effect.fail(new WorkspaceError({ operation: "sync", message: "Teammate membership disappeared" })),
            ),
            Effect.mapError((error) =>
              error instanceof TeamV2.MembershipError
                ? new WorkspaceError({ operation: "sync", message: error.message })
                : error,
            ),
          )
          return { member, conflicts: result.conflicts }
        }),
      ),
    )

    const cleanupMember = Effect.fn("TeamWorkspace.cleanupMember")(function* (
      team: Team.Info,
      member: Team.Member,
      force: boolean,
    ) {
      const target = yield* repository(team.location.directory, "cleanup")
      const source = yield* git.repo.discover(AbsolutePath.make(member.directory))
      if (!source) {
        yield* git.worktree
          .deleteBranch({ repository: target, branch: member.branch, force })
          .pipe(Effect.catch(() => Effect.void))
        return
      }
      if (!force) {
        const [clean, head, pending] = yield* Effect.all(
          [
            git.history.clean(source),
            git.history.head(source),
            teams
              .submissions(team.id)
              .pipe(
                Effect.map((submissions) =>
                  submissions.some(
                    (submission) =>
                      submission.memberID === member.id &&
                      !["applied", "failed", "cancelled"].includes(submission.status),
                  ),
                ),
              ),
          ],
          { concurrency: 3 },
        ).pipe(
          Effect.mapError(
            (error) =>
              new WorkspaceError({ operation: "cleanup", directory: member.directory, message: error.message }),
          ),
        )
        if (!clean || pending || (head !== member.baseCommit && head !== member.lastIntegratedCommit)) return
      }
      yield* git.worktree
        .remove({ repository: target, directory: AbsolutePath.make(member.directory), force })
        .pipe(
          Effect.mapError(
            (error) =>
              new WorkspaceError({ operation: "cleanup", directory: member.directory, message: error.message }),
          ),
        )
      yield* git.worktree
        .deleteBranch({ repository: target, branch: member.branch, force })
        .pipe(
          Effect.mapError(
            (error) =>
              new WorkspaceError({ operation: "cleanup", directory: member.directory, message: error.message }),
          ),
        )
    })

    const finalize = Effect.fn("TeamWorkspace.finalize")(function* (team: Team.Info) {
      const target = yield* repository(team.location.directory, "cleanup").pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not open repository while finalizing Team", { teamID: team.id, cause }).pipe(
            Effect.as(undefined),
          ),
        ),
      )
      if (target) {
        yield* Effect.forEach(
          yield* teams.submissions(team.id),
          (submission) =>
            git.collaboration.deleteRef({ repository: target, ref: submissionRef(team.id, submission.id) }).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Could not delete Team submission ref", {
                  teamID: team.id,
                  submissionID: submission.id,
                  cause,
                }),
              ),
            ),
          { discard: true },
        )
        yield* git.collaboration
          .deleteRef({ repository: target, ref: integrationRef(team.id) })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Could not delete Team integration ref", { teamID: team.id, cause }),
            ),
          )
      }
      yield* fs
        .remove(path.join(root, team.id.slice(-12), ".integration"), { recursive: true, force: true })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not remove Team integration workspace", { teamID: team.id, cause }),
          ),
        )
    })

    const cleanup = (team: Team.Info, member: Team.Member, force: boolean) =>
      withLock(team.id, cleanupMember(team, member, force))

    const close = (actor: TeamV2.Caller, force: boolean) =>
      withLock(
        actor.team.id,
        withCoordinationLock(
          actor.team.id,
          Effect.gen(function* () {
            const current = yield* teams.get(actor.team.id)
            const closed = yield* teams.close(actor)
            yield* Effect.forEach(
              current.members,
              (member) =>
                cleanupMember(current, member, force).pipe(
                  Effect.catchCause((cause) =>
                    Effect.logWarning("Could not clean up Team member workspace", {
                      teamID: current.id,
                      memberID: member.id,
                      cause,
                    }),
                  ),
                ),
              { discard: true },
            )
            yield* finalize(closed)
            return closed
          }),
        ),
      )

    const validate = Effect.fnUntraced(function* (directory: AbsolutePath, commands: ReadonlyArray<string>) {
      if (!commands.length) return { success: true, output: "No validation commands configured." }
      const output: string[] = []
      for (const command of commands) {
        const result = yield* appProcess
          .run(
            ChildProcess.make(command, [], {
              cwd: directory,
              shell: process.env.SHELL ?? "/bin/sh",
              stdin: "ignore",
              extendEnv: true,
            }),
            { combineOutput: true, maxOutputBytes: 512_000, timeout: "10 minutes" },
          )
          .pipe(
            Effect.mapError(
              (error) => new WorkspaceError({ operation: "validate", directory, message: error.message }),
            ),
          )
        output.push(`$ ${command}\n${result.output?.toString("utf8") ?? ""}`)
        if (result.exitCode !== 0) return { success: false, output: output.join("\n\n") }
      }
      return { success: true, output: output.join("\n\n") }
    })

    return Service.of({
      root,
      withLock,
      withCoordinationLock,
      preflight,
      initialize,
      provision,
      submit,
      apply,
      applyLocked,
      sync,
      cleanup,
      close,
    })
  }),
)

const integrationRef = (teamID: Team.ID) => `refs/opencode/teams/${teamID}/integration`
const submissionRef = (teamID: Team.ID, submissionID: Team.SubmissionID) =>
  `refs/opencode/teams/${teamID}/submissions/${submissionID}`

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Git.node, FSUtil.node, Global.node, AppProcess.node, TeamV2.node],
})
