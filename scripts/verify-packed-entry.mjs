import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import process from 'node:process'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const WORKSPACE_ROOT = process.cwd()
const TEMP_DIRECTORY_PREFIX = 'smarter-faster-better-mcp-pack-'
const PACK_ARCHIVE_FIELD = 'filename'
const DIST_ENTRY_SEGMENTS = ['dist', 'index.js']
const NODE_MODULES_SEGMENT = 'node_modules'
const NPM_EXECUTABLE = 'npm'
const PACK_ARGUMENTS = ['pack', '--json', '--quiet', '--ignore-scripts']
const INSTALL_ARGUMENTS = ['install', '--ignore-scripts', '--no-package-lock', '--no-save']

function runCommand(command, args, cwd) {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: 'pipe',
  }).trim()
}

function packWorkspace() {
  const output = runCommand(NPM_EXECUTABLE, PACK_ARGUMENTS, WORKSPACE_ROOT)
  const [packResult] = JSON.parse(output)
  if (!packResult || typeof packResult !== 'object') {
    throw new Error('npm pack did not return package metadata.')
  }

  const archiveName = packResult[PACK_ARCHIVE_FIELD]
  if (typeof archiveName !== 'string' || archiveName.length === 0) {
    throw new Error('npm pack did not return an archive filename.')
  }

  return path.join(WORKSPACE_ROOT, archiveName)
}

function getPackageName() {
  const packageJsonPath = path.join(WORKSPACE_ROOT, 'package.json')
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'))

  if (!packageJson || typeof packageJson !== 'object' || typeof packageJson.name !== 'string') {
    throw new Error('Workspace package.json does not contain a valid package name.')
  }

  return packageJson.name
}

async function verifyPackedEntrypoint() {
  const tempDirectory = mkdtempSync(path.join(tmpdir(), TEMP_DIRECTORY_PREFIX))
  const archivePath = packWorkspace()
  const packageName = getPackageName()

  try {
    writeFileSync(
      path.join(tempDirectory, 'package.json'),
      JSON.stringify({ private: true, name: 'pack-verification-workspace' }, null, 2),
    )

    runCommand(NPM_EXECUTABLE, [...INSTALL_ARGUMENTS, archivePath], tempDirectory)

    const entryPath = path.join(tempDirectory, NODE_MODULES_SEGMENT, packageName, ...DIST_ENTRY_SEGMENTS)
    await import(pathToFileURL(entryPath).href)

    globalThis.console.log('[verify:pack] Packed entrypoint imported successfully.')
  } finally {
    rmSync(archivePath, { force: true })
    rmSync(tempDirectory, { recursive: true, force: true })
  }
}

await verifyPackedEntrypoint()
