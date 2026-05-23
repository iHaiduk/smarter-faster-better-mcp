import * as fs from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** Helper to check if a file exists using standard Node.js fs. */
export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

/** Helper to run an external shell command securely and return its stdout. */
export async function runCommand(args: string[], cwd: string = process.cwd()): Promise<string> {
  const [cmd, ...cmdArgs] = args
  if (!cmd) return ''
  try {
    const { stdout } = await execFileAsync(cmd, cmdArgs, {
      cwd,
      maxBuffer: 10 * 1024 * 1024,
    })
    return stdout
  } catch {
    return ''
  }
}
