import { describe, expect } from "bun:test"
import { $ } from "bun"
import fs from "fs/promises"
import path from "path"
import os from "os"
import { randomUUID } from "crypto"
import { Team } from "@opencode-ai/schema/team"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Database } from "@opencode-ai/core/database/database"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Git } from "@opencode-ai/core/git"
import { Global } from "@opencode-ai/core/global"
import { Location } from "@opencode-ai/core/location"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { TeamV2 } from "@opencode-ai/core/team"
import { TeamWorkspace } from "@opencode-ai/core/team/workspace"
import { Deferred, Effect, Fiber } from "effect"
import { testEffect } from "./lib/effect"
import { tmpdir } from "./fixture/tmpdir"

const data = path.join(os.tmpdir(), `opencode-team-workspace-test-${process.pid}-${randomUUID()}`)
const globalNode = makeGlobalNode({
  service: Global.Service,
  layer: Global.layerWith({ data }),
  deps: [],
})
const layer = AppNodeBuilder.build(LayerNode.group([Database.node, Git.node, TeamV2.node, TeamWorkspace.node]), [
  [Global.node, globalNode],
])
const it = testEffect(layer)

describe("TeamWorkspace", () => {
  it.live("keeps coordination available while integration is locked", () =>
    Effect.gen(function* () {
      const fixture = yield* setup()
      const started = yield* Deferred.make<void>()
      const gate = yield* Deferred.make<void>()
      const integration = yield* fixture.workspace
        .withLock(fixture.team.id, Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(gate))))
        .pipe(Effect.forkChild)
      yield* Deferred.await(started)

      expect(yield* fixture.workspace.withCoordinationLock(fixture.team.id, Effect.succeed("available"))).toBe(
        "available",
      )
      yield* Deferred.succeed(gate, undefined)
      yield* Fiber.join(integration)
    }),
  )

  it.live("captures, validates, and applies teammate changes through an integration worktree", () =>
    Effect.gen(function* () {
      const fixture = yield* setup()
      const staged = yield* submitChange(fixture, "submit")

      expect(staged.status).toBe("ready")
      expect(yield* Effect.promise(() => fs.readFile(path.join(fixture.root.path, "feature.txt"), "utf8"))).toBe(
        "before\n",
      )
      const applied = yield* fixture.workspace.apply(staged)
      expect(applied.status).toBe("applied")
      expect(yield* Effect.promise(() => fs.readFile(path.join(fixture.root.path, "feature.txt"), "utf8"))).toBe(
        "after\n",
      )
      const memberRepository = yield* fixture.git.repo.discover(AbsolutePath.make(fixture.member.directory))
      if (!memberRepository) throw new Error("Member repository not found")
      expect(yield* fixture.git.history.clean(memberRepository)).toBe(true)
    }),
  )

  it.live("bypasses repository hooks and signing for synthetic integration commits", () =>
    Effect.gen(function* () {
      const fixture = yield* setup()
      yield* Effect.promise(async () => {
        const hook = path.join(fixture.root.path, ".git", "hooks", "pre-commit")
        await fs.writeFile(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 })
        await $`git config commit.gpgsign true`.cwd(fixture.root.path).quiet()
      })

      expect((yield* submitChange(fixture, "submit-hooks")).status).toBe("ready")
    }),
  )

  it.live("waits on the target branch before applying validated integration", () =>
    Effect.gen(function* () {
      const fixture = yield* setup()
      const staged = yield* submitChange(fixture, "submit-target-branch")
      yield* Effect.promise(() => $`git switch -c other`.cwd(fixture.root.path).quiet())

      expect((yield* fixture.workspace.apply(staged)).status).toBe("ready")
      expect(yield* Effect.promise(() => fs.readFile(path.join(fixture.root.path, "feature.txt"), "utf8"))).toBe(
        "before\n",
      )

      yield* Effect.promise(() => $`git switch dev`.cwd(fixture.root.path).quiet())
      expect((yield* fixture.workspace.apply(staged)).status).toBe("applied")
    }),
  )

  it.live("keeps validated integration retryable while the lead checkout is dirty", () =>
    Effect.gen(function* () {
      const fixture = yield* setup()
      const staged = yield* submitChange(fixture, "submit-dirty-lead")
      const scratch = path.join(fixture.root.path, "scratch.txt")
      yield* Effect.promise(() => fs.writeFile(scratch, "local\n"))

      expect((yield* fixture.workspace.apply(staged)).status).toBe("ready")
      yield* Effect.promise(() => fs.rm(scratch))
      expect((yield* fixture.workspace.apply(staged)).status).toBe("applied")
    }),
  )

  it.live("recognizes validated integration already contained in the target branch", () =>
    Effect.gen(function* () {
      const fixture = yield* setup()
      const staged = yield* submitChange(fixture, "submit-contained")
      if (!staged.resultCommit) throw new Error("Missing staged commit")
      const head = yield* fixture.git.history.head(fixture.repository)
      if (!head) throw new Error("Missing target HEAD")
      yield* fixture.git.collaboration.applyFastForward({
        repository: fixture.repository,
        expectedCommit: head,
        resultCommit: staged.resultCommit,
      })
      yield* Effect.promise(async () => {
        await fs.writeFile(path.join(fixture.root.path, "later.txt"), "later\n")
        await $`git add later.txt`.cwd(fixture.root.path).quiet()
        await $`git commit --no-verify --no-gpg-sign -m later`.cwd(fixture.root.path).quiet()
      })

      expect((yield* fixture.workspace.apply(staged)).status).toBe("applied")
    }),
  )

  it.live("repairs a stale registration for a missing teammate worktree", () =>
    Effect.gen(function* () {
      const fixture = yield* setup()
      yield* Effect.promise(() => fs.rm(fixture.member.directory, { recursive: true, force: true }))

      const repaired = yield* fixture.workspace.provision(fixture.team, fixture.member)
      expect(yield* fixture.git.history.branch(repaired)).toBe(fixture.member.branch)
    }),
  )

  it.live("reconciles an exact submission retry without falsely applying it", () =>
    Effect.gen(function* () {
      const fixture = yield* setup()
      const staged = yield* submitChange(fixture, "submit-retry")
      const retried = yield* fixture.workspace.submit(staged, fixture.actor)

      expect(retried).toEqual(staged)
      expect(retried.status).toBe("ready")
      expect(yield* Effect.promise(() => fs.readFile(path.join(fixture.root.path, "feature.txt"), "utf8"))).toBe(
        "before\n",
      )
    }),
  )

  it.live("resumes a queued capture without discarding newer teammate edits", () =>
    Effect.gen(function* () {
      const fixture = yield* setup()
      yield* fixture.teams.task(fixture.actor, { action: "claim", taskID: fixture.task.id })
      yield* Effect.promise(() => fs.writeFile(path.join(fixture.member.directory, "feature.txt"), "after\n"))
      yield* fixture.teams.task(fixture.actor, {
        action: "complete",
        taskID: fixture.task.id,
        summary: "Updated feature",
      })
      const reserved = yield* fixture.teams.reserveSubmission({
        caller: fixture.actor,
        taskID: fixture.task.id,
        parentAssistantMessageID: SessionMessage.ID.create(),
        parentToolCallID: "submit-queued-recovery",
      })
      const memberRepository = yield* fixture.git.repo.discover(AbsolutePath.make(fixture.member.directory))
      if (!memberRepository) throw new Error("Member repository not found")
      const capture = yield* fixture.git.collaboration.captureCommit({
        repository: memberRepository,
        message: "capture before interruption",
      })
      const queued = yield* fixture.teams.submissionStatus(reserved.id, "queued", {
        sourceCommit: capture.commit,
        expectedIntegrationCommit: fixture.team.integrationCommit,
      })
      yield* Effect.promise(() => fs.writeFile(path.join(fixture.member.directory, "next.txt"), "newer\n"))

      expect((yield* fixture.workspace.submit(queued, fixture.actor)).status).toBe("ready")
      expect(yield* Effect.promise(() => fs.readFile(path.join(fixture.member.directory, "next.txt"), "utf8"))).toBe(
        "newer\n",
      )
    }),
  )

  it.live("serializes concurrent application of the same ready submission", () =>
    Effect.gen(function* () {
      const fixture = yield* setup()
      const staged = yield* submitChange(fixture, "submit-concurrent-apply")
      const applied = yield* Effect.all([fixture.workspace.apply(staged), fixture.workspace.apply(staged)], {
        concurrency: "unbounded",
      })

      expect(applied.map((submission) => submission.status)).toEqual(["applied", "applied"])
      expect(yield* Effect.promise(() => fs.readFile(path.join(fixture.root.path, "feature.txt"), "utf8"))).toBe(
        "after\n",
      )
    }),
  )

  it.live("recovers an applying submission after the lead fast-forward committed", () =>
    Effect.gen(function* () {
      const fixture = yield* setup()
      const staged = yield* submitChange(fixture, "submit-applying-recovery")
      if (!staged.resultCommit) throw new Error("Missing staged commit")
      const head = yield* fixture.git.history.head(fixture.repository)
      if (!head) throw new Error("Missing target HEAD")
      yield* fixture.teams.submissionStatus(staged.id, "applying")
      yield* fixture.git.collaboration.applyFastForward({
        repository: fixture.repository,
        expectedCommit: head,
        resultCommit: staged.resultCommit,
      })

      expect((yield* fixture.workspace.apply(staged)).status).toBe("applied")
      expect(yield* Effect.promise(() => fs.readFile(path.join(fixture.root.path, "feature.txt"), "utf8"))).toBe(
        "after\n",
      )
    }),
  )

  it.live("finalizes lead application when the teammate worktree became dirty", () =>
    Effect.gen(function* () {
      const fixture = yield* setup()
      const staged = yield* submitChange(fixture, "submit-dirty-member")
      yield* Effect.promise(() => fs.writeFile(path.join(fixture.member.directory, "next.txt"), "new work\n"))
      const applied = yield* fixture.workspace.apply(staged)

      expect(applied.status).toBe("applied")
      expect(yield* Effect.promise(() => fs.readFile(path.join(fixture.root.path, "feature.txt"), "utf8"))).toBe(
        "after\n",
      )
      expect(yield* Effect.promise(() => fs.readFile(path.join(fixture.member.directory, "next.txt"), "utf8"))).toBe(
        "new work\n",
      )
    }),
  )

  it.live("keeps validation failures out of the lead checkout", () =>
    Effect.gen(function* () {
      const fixture = yield* setup(["false"])
      const staged = yield* submitChange(fixture, "submit-invalid")

      expect(staged.status).toBe("validation_failed")
      expect(yield* Effect.promise(() => fs.readFile(path.join(fixture.root.path, "feature.txt"), "utf8"))).toBe(
        "before\n",
      )
    }),
  )

  it.live("preserves a merge conflict for teammate resolution and resubmission", () =>
    Effect.gen(function* () {
      const fixture = yield* setup(['test "$(cat feature.txt)" = resolved'])
      yield* fixture.teams.task(fixture.actor, { action: "claim", taskID: fixture.task.id })
      yield* Effect.promise(() => fs.writeFile(path.join(fixture.member.directory, "feature.txt"), "member\n"))
      yield* fixture.teams.task(fixture.actor, {
        action: "complete",
        taskID: fixture.task.id,
        summary: "Updated feature",
      })
      yield* Effect.promise(async () => {
        await fs.writeFile(path.join(fixture.root.path, "feature.txt"), "integration\n")
        await $`git add feature.txt`.cwd(fixture.root.path).quiet()
        await $`git commit -m integration`.cwd(fixture.root.path).quiet()
      })
      const integrationCommit = yield* fixture.git.history.head(fixture.repository)
      if (!integrationCommit) throw new Error("Missing integration commit")
      expect(yield* fixture.teams.advanceIntegration(fixture.team.id, fixture.team.baseCommit, integrationCommit)).toBe(
        true,
      )
      const current = yield* fixture.teams.get(fixture.team.id)
      yield* fixture.workspace.initialize(current)
      const actor = yield* fixture.teams.caller(fixture.member.sessionID)
      const first = yield* fixture.teams.reserveSubmission({
        caller: actor,
        taskID: fixture.task.id,
        parentAssistantMessageID: SessionMessage.ID.create(),
        parentToolCallID: "submit-conflict",
      })
      const conflicted = yield* fixture.workspace.submit(first, actor)

      expect(conflicted.status).toBe("conflicted")
      const synchronized = yield* fixture.workspace.sync(actor)
      expect(synchronized.conflicts).toEqual(["feature.txt"])
      yield* Effect.promise(() => fs.writeFile(path.join(fixture.member.directory, "feature.txt"), "resolved\n"))
      const refreshed = yield* fixture.teams.caller(fixture.member.sessionID)
      const retry = yield* fixture.teams.reserveSubmission({
        caller: refreshed,
        taskID: fixture.task.id,
        parentAssistantMessageID: SessionMessage.ID.create(),
        parentToolCallID: "submit-resolution",
      })
      const staged = yield* fixture.workspace.submit(retry, refreshed)
      expect(staged.status).toBe("ready")
      expect((yield* fixture.teams.submissions(fixture.team.id))[0].status).toBe("cancelled")
      expect((yield* fixture.workspace.apply(staged)).status).toBe("applied")
      expect(yield* Effect.promise(() => fs.readFile(path.join(fixture.root.path, "feature.txt"), "utf8"))).toBe(
        "resolved\n",
      )
    }),
  )

  it.live("closes normally while preserving unresolved teammate work", () =>
    Effect.gen(function* () {
      const fixture = yield* setup(["false"])
      const staged = yield* submitChange(fixture, "submit-preserved")
      const lead = yield* fixture.teams.caller(fixture.team.leadSessionID)
      const closed = yield* fixture.workspace.close(lead, false)

      expect(staged.status).toBe("validation_failed")
      expect(closed.status).toBe("closed")
      expect(yield* Effect.promise(() => fs.stat(fixture.member.directory).then(() => true))).toBe(true)
      expect((yield* fixture.teams.submissions(fixture.team.id))[0].status).toBe("cancelled")
    }),
  )

  it.live("removes unresolved teammate work only when close is forced", () =>
    Effect.gen(function* () {
      const fixture = yield* setup(["false"])
      yield* submitChange(fixture, "submit-force-close")
      const lead = yield* fixture.teams.caller(fixture.team.leadSessionID)
      expect((yield* fixture.workspace.close(lead, true)).status).toBe("closed")
      expect(
        yield* Effect.promise(() =>
          fs
            .stat(fixture.member.directory)
            .then(() => true)
            .catch(() => false),
        ),
      ).toBe(false)
    }),
  )
})

const setup = (validation: ReadonlyArray<string> = ['test "$(cat feature.txt)" = after']) =>
  Effect.gen(function* () {
    const root = yield* Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    )
    yield* Effect.addFinalizer(() => Effect.promise(() => fs.rm(data, { recursive: true, force: true })))
    yield* Effect.promise(async () => {
      await $`git init -b dev`.cwd(root.path).quiet()
      await $`git config core.fsmonitor false`.cwd(root.path).quiet()
      await $`git config commit.gpgsign false`.cwd(root.path).quiet()
      await $`git config user.email test@opencode.test`.cwd(root.path).quiet()
      await $`git config user.name Test`.cwd(root.path).quiet()
      await fs.writeFile(path.join(root.path, "feature.txt"), "before\n")
      await $`git add feature.txt`.cwd(root.path).quiet()
      await $`git commit -m initial`.cwd(root.path).quiet()
    })
    const git = yield* Git.Service
    const repository = yield* git.repo.discover(AbsolutePath.make(root.path))
    if (!repository) throw new Error("Repository not found")
    const commit = yield* git.history.head(repository)
    if (!commit) throw new Error("Missing HEAD")
    const teams = yield* TeamV2.Service
    const workspace = yield* TeamWorkspace.Service
    const { db } = yield* Database.Service
    const leadSessionID = SessionV2.ID.make(`ses_team_workspace_${randomUUID().replaceAll("-", "")}`)
    yield* db
      .insert(ProjectTable)
      .values({ id: ProjectV2.ID.global, worktree: repository.worktree, sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: leadSessionID,
        project_id: ProjectV2.ID.global,
        slug: leadSessionID,
        directory: repository.worktree,
        title: "Team lead",
        version: "test",
      })
      .run()
      .pipe(Effect.orDie)
    const model = ModelV2.Ref.make({ providerID: ProviderV2.ID.anthropic, id: ModelV2.ID.make("claude") })
    const team = yield* teams.reserve({
      leadSessionID,
      parentAssistantMessageID: SessionMessage.ID.create(),
      parentToolCallID: "spawn",
      projectID: ProjectV2.ID.global,
      location: Location.Ref.make({ directory: repository.worktree }),
      targetBranch: "dev",
      baseCommit: commit,
      directoryRoot: workspace.root,
      agent: AgentV2.ID.make("build"),
      permission: [],
      members: [{ name: Team.Name.make("writer"), model, prompt: "Write the feature" }],
      tasks: [
        {
          key: Team.Name.make("feature"),
          title: "Feature",
          description: "Change feature.txt",
          assignee: Team.Name.make("writer"),
        },
      ],
      validation,
    })
    yield* workspace.initialize(team)
    const member = (yield* teams.reservedMembers(team.id))[0]
    yield* workspace.provision(team, member)
    yield* teams.memberStatus(member.id, "idle")
    yield* teams.activate(team.id)
    const actor = yield* teams.caller(member.sessionID)
    return { root, git, repository, teams, workspace, team, member, actor, task: (yield* teams.tasks(team.id))[0] }
  })

const submitChange = Effect.fnUntraced(function* (
  fixture: Effect.Success<ReturnType<typeof setup>>,
  toolCallID: string,
) {
  yield* fixture.teams.task(fixture.actor, { action: "claim", taskID: fixture.task.id })
  yield* Effect.promise(() => fs.writeFile(path.join(fixture.member.directory, "feature.txt"), "after\n"))
  yield* fixture.teams.task(fixture.actor, {
    action: "complete",
    taskID: fixture.task.id,
    summary: "Updated feature",
  })
  const reserved = yield* fixture.teams.reserveSubmission({
    caller: fixture.actor,
    taskID: fixture.task.id,
    parentAssistantMessageID: SessionMessage.ID.create(),
    parentToolCallID: toolCallID,
  })
  return yield* fixture.workspace.submit(reserved, fixture.actor)
})
