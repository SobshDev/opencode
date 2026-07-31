#!/usr/bin/env bun

import { $ } from "bun"
import path from "path"
import { chmod, mkdir, rename } from "fs/promises"
import { homedir } from "os"

const existing = Bun.which("opencode")
const directory = existing ? path.dirname(existing) : path.join(homedir(), ".opencode", "bin")
const executable = process.platform === "win32" ? "opencode.exe" : "opencode"
const target = existing ?? path.join(directory, executable)

await $`bun run --cwd packages/opencode build --single --skip-install`

const platform = process.platform === "win32" ? "windows" : process.platform
const source = path.resolve(`packages/opencode/dist/opencode-${platform}-${process.arch}/bin/${executable}`)
if (!(await Bun.file(source).exists())) {
  throw new Error(`Build did not produce the expected executable: ${source}`)
}

await mkdir(directory, { recursive: true })
const temporary = `${target}.new`
await Bun.write(temporary, Bun.file(source))
await chmod(temporary, 0o755)
await rename(temporary, target)

console.log(`Installed ${await $`${target} --version`.text().then((output) => output.trim())} to ${target}`)

if (!existing && !process.env.PATH?.split(path.delimiter).includes(directory)) {
  console.log(`Add ${directory} to PATH to use opencode.`)
}
