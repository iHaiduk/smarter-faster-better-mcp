import * as path from 'node:path'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'

const PROJECT_MARKERS = [
  '.git',
  'package.json',
  'Cargo.toml',
  'go.mod',
  'pyproject.toml',
  'requirements.txt',
  'pom.xml',
  'build.gradle',
  'composer.json',
  'pubspec.yaml',
  'Gemfile',
  'Package.swift',
  '.project_map.json',
] as const

function findProjectRoot(startDir: string): string | null {
  let current = path.resolve(startDir)
  const home = homedir()

  while (true) {
    for (const marker of PROJECT_MARKERS) {
      if (existsSync(path.join(current, marker))) {
        return current
      }
    }

    const parent = path.dirname(current)
    if (parent === current || current === home) {
      break
    }
    current = parent
  }

  return null
}

export function resolveWorkspaceRoot(workspaceRoot?: string): string {
  if (workspaceRoot && workspaceRoot.trim().length > 0) {
    return path.resolve(process.cwd(), workspaceRoot.trim())
  }

  const envRoot =
    process.env['SCOUT_WORKSPACE_ROOT']?.trim() ||
    process.env['WORKSPACE_ROOT']?.trim() ||
    process.env['PROJECT_ROOT']?.trim()

  if (envRoot && envRoot.length > 0) {
    return path.resolve(process.cwd(), envRoot)
  }

  const discovered = findProjectRoot(process.cwd())
  return discovered ?? process.cwd()
}
