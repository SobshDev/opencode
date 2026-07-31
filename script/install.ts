#!/usr/bin/env bun

import { $ } from "bun"
import path from "path"
import { appendFile, chmod, mkdir, rename } from "fs/promises"
import { homedir } from "os"

// Bun also invokes an "install" script as a lifecycle hook during dependency installation.
if (process.env.npm_lifecycle_event !== "install") process.exit(0)

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
  const shell = path.basename(process.env.SHELL ?? "")
  const config =
    shell === "zsh"
      ? path.join(process.env.ZDOTDIR ?? homedir(), ".zshrc")
      : shell === "bash"
        ? path.join(homedir(), process.platform === "darwin" ? ".bash_profile" : ".bashrc")
        : shell === "fish"
          ? path.join(homedir(), ".config", "fish", "config.fish")
          : path.join(homedir(), ".profile")
  const command =
    shell === "fish" ? `fish_add_path "${directory}" # opencode` : `export PATH="${directory}:$PATH" # opencode`
  const contents = (await Bun.file(config).exists()) ? await Bun.file(config).text() : ""

  await mkdir(path.dirname(config), { recursive: true })
  if (!contents.split("\n").includes(command))
    await appendFile(config, `${contents.endsWith("\n") || !contents ? "" : "\n"}${command}\n`)
  console.log(`Added ${directory} to PATH in ${config}. Restart your shell to use opencode.`)
}
