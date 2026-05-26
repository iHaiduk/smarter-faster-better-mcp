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

describe('cleanupWorkspace Functionality', () => {
  const testWorkspaceRoot = path.join(import.meta.dir, 'temp_cleanup_test_dir')

  beforeAll(async () => {
    // Ensure clean state
    await fs.rm(testWorkspaceRoot, { recursive: true, force: true }).catch(() => {})
    await fs.mkdir(testWorkspaceRoot, { recursive: true })

    // Create a mock workspace directory structure
    await fs.mkdir(path.join(testWorkspaceRoot, 'node_modules'), { recursive: true })
    await fs.mkdir(path.join(testWorkspaceRoot, 'bower_components'), { recursive: true })
    await fs.mkdir(path.join(testWorkspaceRoot, 'src'), { recursive: true })
    await fs.mkdir(path.join(testWorkspaceRoot, 'dist'), { recursive: true })
    await fs.mkdir(path.join(testWorkspaceRoot, '.git'), { recursive: true })
    await fs.mkdir(path.join(testWorkspaceRoot, '.vscode'), { recursive: true })
    await fs.mkdir(path.join(testWorkspaceRoot, 'cache'), { recursive: true })

    // Create files inside directories
    await fs.writeFile(path.join(testWorkspaceRoot, 'node_modules', 'some-pkg.js'), 'pkg code')
    await fs.writeFile(path.join(testWorkspaceRoot, 'bower_components', 'component.js'), 'comp code')
    await fs.writeFile(path.join(testWorkspaceRoot, 'src', 'index.ts'), 'export const main = () => {}')
    await fs.writeFile(path.join(testWorkspaceRoot, 'dist', 'bundle.js'), 'bundle code')
    await fs.writeFile(path.join(testWorkspaceRoot, '.git', 'HEAD'), 'ref: refs/heads/main')
    await fs.writeFile(path.join(testWorkspaceRoot, '.vscode', 'settings.json'), '{}')
    await fs.writeFile(path.join(testWorkspaceRoot, 'cache', 'data.json'), '{}')

    // Create root level files
    await fs.writeFile(path.join(testWorkspaceRoot, '.env'), 'PORT=3000')
    await fs.writeFile(path.join(testWorkspaceRoot, '.gitignore'), 'node_modules')
    await fs.writeFile(path.join(testWorkspaceRoot, 'tsconfig.json'), '{}')
    await fs.writeFile(path.join(testWorkspaceRoot, '.DS_Store'), 'junk data')
    await fs.writeFile(path.join(testWorkspaceRoot, 'main.ts'), 'console.log("hello")')
  })

  afterAll(async () => {
    // Cleanup temporary directory
    await fs.rm(testWorkspaceRoot, { recursive: true, force: true }).catch(() => {})
  })

  test('correctly lists paths for dryRun without deleting anything', async () => {
    const result = await cleanupWorkspace(testWorkspaceRoot, { dryRun: true })

    // Verify correct items identified as deleted/preserved
    expect(result.deleted).toContain('dist')
    expect(result.deleted).toContain('.git')
    expect(result.deleted).toContain('.vscode')
    expect(result.deleted).toContain('cache')
    expect(result.deleted).toContain('.DS_Store')

    expect(result.preserved).toContain('node_modules')
    expect(result.preserved).toContain('bower_components')
    expect(result.preserved).toContain('src')
    expect(result.preserved).toContain('.env')
    expect(result.preserved).toContain('.gitignore')
    expect(result.preserved).toContain('tsconfig.json')
    expect(result.preserved).toContain('main.ts')

    // Verify files still exist on disk
    expect(await fs.stat(path.join(testWorkspaceRoot, 'dist')).then((s) => s.isDirectory())).toBe(true)
    expect(await fs.stat(path.join(testWorkspaceRoot, '.git')).then((s) => s.isDirectory())).toBe(true)
    expect(await fs.stat(path.join(testWorkspaceRoot, '.DS_Store')).then((s) => s.isFile())).toBe(true)
  })

  test('correctly deletes unwanted folders/files and preserves critical ones on actual run', async () => {
    const result = await cleanupWorkspace(testWorkspaceRoot, { dryRun: false })

    expect(result.deleted).toContain('dist')
    expect(result.deleted).toContain('.git')
    expect(result.deleted).toContain('.vscode')
    expect(result.deleted).toContain('cache')
    expect(result.deleted).toContain('.DS_Store')

    // Verify deleted items are actually gone
    const checkExists = async (p: string) =>
      fs
        .stat(p)
        .then(() => true)
        .catch(() => false)

    expect(await checkExists(path.join(testWorkspaceRoot, 'dist'))).toBe(false)
    expect(await checkExists(path.join(testWorkspaceRoot, '.git'))).toBe(false)
    expect(await checkExists(path.join(testWorkspaceRoot, '.vscode'))).toBe(false)
    expect(await checkExists(path.join(testWorkspaceRoot, 'cache'))).toBe(false)
    expect(await checkExists(path.join(testWorkspaceRoot, '.DS_Store'))).toBe(false)

    // Verify preserved items are still present
    expect(await checkExists(path.join(testWorkspaceRoot, 'node_modules'))).toBe(true)
    expect(await checkExists(path.join(testWorkspaceRoot, 'bower_components'))).toBe(true)
    expect(await checkExists(path.join(testWorkspaceRoot, 'src'))).toBe(true)
    expect(await checkExists(path.join(testWorkspaceRoot, '.env'))).toBe(true)
    expect(await checkExists(path.join(testWorkspaceRoot, '.gitignore'))).toBe(true)
    expect(await checkExists(path.join(testWorkspaceRoot, 'tsconfig.json'))).toBe(true)
    expect(await checkExists(path.join(testWorkspaceRoot, 'main.ts'))).toBe(true)

    // Verify nested node_modules / src files are preserved
    expect(await checkExists(path.join(testWorkspaceRoot, 'node_modules', 'some-pkg.js'))).toBe(true)
    expect(await checkExists(path.join(testWorkspaceRoot, 'bower_components', 'component.js'))).toBe(true)
    expect(await checkExists(path.join(testWorkspaceRoot, 'src', 'index.ts'))).toBe(true)
  })
})
