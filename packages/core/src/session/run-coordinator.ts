export * as SessionRunCoordinator from "./run-coordinator"

import { Deferred, Effect, Exit, Fiber, FiberSet, Scope } from "effect"

/** Serializes execution for each key while allowing different keys to run concurrently. */
export interface Coordinator<Key, E> {
  /** Snapshots keys with an execution owned by this coordinator. */
  readonly active: Effect.Effect<ReadonlySet<Key>>
  /** Starts execution while idle or joins the active execution. */
  readonly run: (key: Key) => Effect.Effect<void, E>
  /** Registers one coalesced follow-up after newly recorded work. */
  readonly wake: (key: Key) => Effect.Effect<void>
  /** Waits until current execution and any already-coalesced successor become idle. */
  readonly wait: (key: Key) => Effect.Effect<void>
  /** Runs one operation while the key is idle, deferring new wakes until it completes. */
  readonly whenIdle: <A, E2, R>(key: Key, effect: Effect.Effect<A, E2, R>) => Effect.Effect<A, E2, R>
  /** Stops active execution and waits for its cleanup. */
  readonly interrupt: (key: Key) => Effect.Effect<void>
}

type Entry<E> = {
  done: Deferred.Deferred<void, E>
  owner?: Fiber.Fiber<unknown, unknown>
  idleOperation: boolean
  pendingWake: boolean
  pendingForce: boolean
  stopping: boolean
  readonly idleWaiters: Entry<E>[]
  readonly afterWakeWaiters: Entry<E>[]
  readonly ready?: Deferred.Deferred<void>
}

export const make = <Key, E>(options: {
  readonly drain: (key: Key, force: boolean) => Effect.Effect<void, E>
}): Effect.Effect<Coordinator<Key, E>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const active = new Map<Key, Entry<E>>()
    const fork = yield* FiberSet.makeRuntime<never, void, never>()

    const makeEntry = (ready?: Deferred.Deferred<void>, idleOperation = false): Entry<E> => ({
      done: Deferred.makeUnsafe<void, E>(),
      idleOperation,
      pendingWake: false,
      pendingForce: false,
      stopping: false,
      idleWaiters: [],
      afterWakeWaiters: [],
      ready,
    })

    const start = (key: Key, entry: Entry<E>, force: boolean, successor = false) => {
      const ready = Deferred.makeUnsafe<void>()
      const owner = fork(
        (successor ? Effect.yieldNow : Deferred.await(ready)).pipe(
          Effect.andThen(Effect.suspend(() => options.drain(key, force))),
          Effect.onExit((exit) => Effect.sync(() => settle(key, entry, exit))),
          Effect.exit,
          Effect.asVoid,
        ),
      )
      entry.owner = owner
      entry.idleOperation = false
      if (!successor) Deferred.doneUnsafe(ready, Effect.void)
    }

    const settle = (key: Key, entry: Entry<E>, exit: Exit.Exit<void, E>) => {
      const idle = entry.idleWaiters.shift()
      if (idle) {
        idle.pendingWake = entry.pendingWake
        idle.pendingForce = entry.pendingForce
        idle.idleWaiters.push(...entry.idleWaiters)
        idle.afterWakeWaiters.push(...entry.afterWakeWaiters)
        active.set(key, idle)
        if (Exit.isSuccess(exit) && entry.pendingWake && !entry.stopping) idle.done = entry.done
        else Deferred.doneUnsafe(entry.done, exit)
        Deferred.doneUnsafe(idle.ready!, Effect.void)
        return
      }
      if (Exit.isSuccess(exit) && !entry.stopping && entry.pendingWake) {
        const force = entry.pendingForce
        entry.pendingWake = false
        entry.pendingForce = false
        entry.idleWaiters.push(...entry.afterWakeWaiters.splice(0))
        start(key, entry, force, true)
        return
      }

      const successor = entry.pendingWake ? makeEntry() : undefined
      if (successor === undefined) active.delete(key)
      else {
        successor.idleWaiters.push(...entry.afterWakeWaiters)
        active.set(key, successor)
        start(key, successor, entry.pendingForce, true)
      }
      Deferred.doneUnsafe(entry.done, exit)
      if (successor !== undefined || !entry.afterWakeWaiters.length) return
      const waiting = entry.afterWakeWaiters.shift()!
      waiting.idleWaiters.push(...entry.afterWakeWaiters)
      active.set(key, waiting)
      Deferred.doneUnsafe(waiting.ready!, Effect.void)
    }

    const run = (key: Key): Effect.Effect<void, E> =>
      Effect.uninterruptibleMask((restore) => {
        const entry = active.get(key)
        if (entry !== undefined) {
          if (entry.stopping) return restore(Deferred.await(entry.done).pipe(Effect.andThen(run(key))))
          if (entry.idleOperation) {
            entry.pendingWake = true
            entry.pendingForce = true
          }
          return restore(Deferred.await(entry.done))
        }

        const next = makeEntry()
        active.set(key, next)
        start(key, next, true)
        return restore(Deferred.await(next.done))
      })

    const wake = (key: Key) =>
      Effect.sync(() => {
        const entry = active.get(key)
        if (entry !== undefined) {
          entry.pendingWake = true
          return
        }

        const next = makeEntry()
        active.set(key, next)
        start(key, next, false)
      })

    const interrupt = (key: Key): Effect.Effect<void> =>
      Effect.suspend(() => {
        const entry = active.get(key)
        if (entry?.owner === undefined || entry.idleOperation) return Effect.void
        entry.stopping = true
        entry.pendingWake = false
        entry.pendingForce = false
        return Fiber.interrupt(entry.owner)
      })

    const wait = (key: Key): Effect.Effect<void> =>
      Effect.suspend(() => {
        const entry = active.get(key)
        if (!entry) return Effect.void
        return Deferred.await(entry.done).pipe(Effect.exit, Effect.andThen(wait(key)))
      })

    const whenIdle = <A, E2, R>(key: Key, effect: Effect.Effect<A, E2, R>): Effect.Effect<A, E2, R> =>
      Effect.uninterruptibleMask((restore) => {
        const entry = active.get(key)
        if (entry !== undefined) {
          const next = makeEntry(Deferred.makeUnsafe<void>(), true)
          if (entry.pendingWake) entry.afterWakeWaiters.push(next)
          else entry.idleWaiters.push(next)
          const cancel = Effect.sync(() => {
            const current = active.get(key)
            if (current === next) {
              settle(key, next, Exit.void)
              return
            }
            if (!current) return
            const idle = current.idleWaiters.indexOf(next)
            if (idle >= 0) current.idleWaiters.splice(idle, 1)
            const afterWake = current.afterWakeWaiters.indexOf(next)
            if (afterWake >= 0) current.afterWakeWaiters.splice(afterWake, 1)
          })
          return restore(Deferred.await(next.ready!)).pipe(
            Effect.onInterrupt(() => cancel),
            Effect.andThen(
              Effect.withFiber((owner) =>
                Effect.sync(() => {
                  next.owner = owner
                }).pipe(
                  Effect.andThen(restore(effect)),
                  Effect.ensuring(Effect.sync(() => settle(key, next, Exit.void))),
                ),
              ),
            ),
          )
        }

        const next = makeEntry(undefined, true)
        active.set(key, next)
        return Effect.withFiber((owner) =>
          Effect.sync(() => {
            next.owner = owner
          }).pipe(Effect.andThen(restore(effect)), Effect.ensuring(Effect.sync(() => settle(key, next, Exit.void)))),
        )
      })

    return { active: Effect.sync(() => new Set(active.keys())), run, wake, wait, whenIdle, interrupt }
  })
