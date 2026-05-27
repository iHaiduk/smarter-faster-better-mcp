import { describe, expect, test, afterAll, beforeAll } from 'bun:test'
import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import { shouldIgnorePath } from '../shared/constants/ignore-rules.js'
import { cleanupWorkspace } from '../shared/fs/cleanup.js'

describe('shouldIgnorePath Filtering Rules', () => {
  test('excludes unwanted dotfiles and hidden folders', () => {
    expect(shouldIgnorePath('.DS_Store')).toBe(true)
    expect(shouldIgnorePath('.git/config')).toBe(true)
    expect(shouldIgnorePath('.vscode/settings.json')).toBe(true)
    expect(shouldIgnorePath('.ide/config.xml')).toBe(true)
    expect(shouldIgnorePath('src/.DS_Store')).toBe(true)
  })

  test('preserves critical configuration files', () => {
    expect(shouldIgnorePath('.env')).toBe(false)
    expect(shouldIgnorePath('.env.example')).toBe(false)
    expect(shouldIgnorePath('.env.production')).toBe(false)
    expect(shouldIgnorePath('.gitignore')).toBe(false)
    expect(shouldIgnorePath('.npmignore')).toBe(false)
    expect(shouldIgnorePath('.eslint.config.js')).toBe(false)
  })

  test('excludes compilation/build/temporary/cache/history directories', () => {
    expect(shouldIgnorePath('node_modules/lodash/index.js')).toBe(true)
    expect(shouldIgnorePath('dist/index.js')).toBe(true)
    expect(shouldIgnorePath('build/App.js')).toBe(true)
    expect(shouldIgnorePath('cache/meta.json')).toBe(true)
    expect(shouldIgnorePath('bin/run.sh')).toBe(true)
    expect(shouldIgnorePath('.scout-cache/map.json')).toBe(true)
    expect(shouldIgnorePath('history/old_v1.ts')).toBe(true)
    expect(shouldIgnorePath('.history/old_v2.ts')).toBe(true)
    expect(shouldIgnorePath('src/history/nested_old.ts')).toBe(true)
    expect(shouldIgnorePath('src/cache/nested_cache.json')).toBe(true)
  })

  test('allows standard source files', () => {
    expect(shouldIgnorePath('src/index.ts')).toBe(false)
    expect(shouldIgnorePath('package.json')).toBe(false)
    expect(shouldIgnorePath('tsconfig.json')).toBe(false)
  })
})

describe('cleanupWorkspace Functionality (Strict Safe Cleanup)', () => {
  const testWorkspaceRoot = path.join(import.meta.dir, 'temp_cleanup_test_dir')

  beforeAll(async () => {
    // Ensure clean state
    await fs.rm(testWorkspaceRoot, { recursive: true, force: true }).catch(() => {})
    await fs.mkdir(testWorkspaceRoot, { recursive: true })

    // Create a mock workspace directory structure
    await fs.mkdir(path.join(testWorkspaceRoot, 'node_modules'), { recursive: true })
    await fs.mkdir(path.join(testWorkspaceRoot, 'src'), { recursive: true })
    await fs.mkdir(path.join(testWorkspaceRoot, 'dist'), { recursive: true })
    await fs.mkdir(path.join(testWorkspaceRoot, '.git'), { recursive: true })
    await fs.mkdir(path.join(testWorkspaceRoot, '.vscode'), { recursive: true })
    await fs.mkdir(path.join(testWorkspaceRoot, '.scout-cache'), { recursive: true })

    // Create files inside directories
    await fs.writeFile(path.join(testWorkspaceRoot, 'src', 'index.ts'), 'export const main = () => {}')
    await fs.writeFile(path.join(testWorkspaceRoot, 'dist', 'bundle.js'), 'bundle code')
    await fs.writeFile(path.join(testWorkspaceRoot, '.vscode', 'settings.json'), '{}')
    await fs.writeFile(path.join(testWorkspaceRoot, '.scout-cache', 'cache-file.json'), '{}')

    // Create root level files
    await fs.writeFile(path.join(testWorkspaceRoot, '.env'), 'PORT=3000')
    await fs.writeFile(path.join(testWorkspaceRoot, '.project_map.json'), '{}')
    await fs.writeFile(path.join(testWorkspaceRoot, 'main.ts'), 'console.log("hello")')
  })

  afterAll(async () => {
    // Cleanup temporary directory
    await fs.rm(testWorkspaceRoot, { recursive: true, force: true }).catch(() => {})
  })

  test('correctly lists only own cache paths for dryRun without deleting anything', async () => {
    const result = await cleanupWorkspace(testWorkspaceRoot, { dryRun: true })

    // Only .scout-cache and .project_map.json should be identified as deleted
    expect(result.deleted).toContain('.scout-cache')
    expect(result.deleted).toContain('.project_map.json')
    expect(result.deleted.length).toBe(2)

    // Verify files still exist on disk
    const checkExists = async (p: string) =>
      fs
        .stat(p)
        .then(() => true)
        .catch(() => false)

    expect(await checkExists(path.join(testWorkspaceRoot, '.scout-cache'))).toBe(true)
    expect(await checkExists(path.join(testWorkspaceRoot, '.project_map.json'))).toBe(true)
    expect(await checkExists(path.join(testWorkspaceRoot, 'dist'))).toBe(true)
    expect(await checkExists(path.join(testWorkspaceRoot, '.git'))).toBe(true)
    expect(await checkExists(path.join(testWorkspaceRoot, '.vscode'))).toBe(true)
  })

  test('deletes ONLY scout-cache and project_map, while preserving user code, configs, git, and build files', async () => {
    const result = await cleanupWorkspace(testWorkspaceRoot, { dryRun: false })

    expect(result.deleted).toContain('.scout-cache')
    expect(result.deleted).toContain('.project_map.json')
    expect(result.deleted.length).toBe(2)

    const checkExists = async (p: string) =>
      fs
        .stat(p)
        .then(() => true)
        .catch(() => false)

    // Verify own cache files are deleted
    expect(await checkExists(path.join(testWorkspaceRoot, '.scout-cache'))).toBe(false)
    expect(await checkExists(path.join(testWorkspaceRoot, '.project_map.json'))).toBe(false)

    // Verify user files/folders are 100% PRESERVED
    expect(await checkExists(path.join(testWorkspaceRoot, 'dist'))).toBe(true)
    expect(await checkExists(path.join(testWorkspaceRoot, '.git'))).toBe(true)
    expect(await checkExists(path.join(testWorkspaceRoot, '.vscode'))).toBe(true)
    expect(await checkExists(path.join(testWorkspaceRoot, 'node_modules'))).toBe(true)
    expect(await checkExists(path.join(testWorkspaceRoot, 'src'))).toBe(true)
    expect(await checkExists(path.join(testWorkspaceRoot, '.env'))).toBe(true)
    expect(await checkExists(path.join(testWorkspaceRoot, 'main.ts'))).toBe(true)
  })
})
