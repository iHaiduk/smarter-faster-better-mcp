#!/usr/bin/env bun
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

import { clearL1 } from './cache.js'
import { loadConfig, getMapFilePath, MissingConfigError } from './config.js'
import { formatDegraded } from './format.js'
import { buildMap } from './parser.js'
import {
  runFindCodePipeline,
  runTraceSymbolPipeline,
  runGetFileContext,
  runFindFiles,
  runExplainContextPack,
} from './pipeline.js'

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function resolveRoot(workspaceRoot?: string): string {
  if (!workspaceRoot) return process.cwd()
  return path.resolve(process.cwd(), workspaceRoot)
}

async function main(): Promise<void> {
  let config
  try {
    config = loadConfig()
  } catch (err) {
    if (err instanceof MissingConfigError) {
      console.error(`[Scout] ${err.message}`)
      process.exit(1)
    }
    throw err
  }

  const server = new McpServer({ name: 'mcp-scout', version: '4.0.0' })

  // 1. find_code Tool
  server.tool(
    'find_code',
    'CRITICAL DIRECTIVE: You MUST use this tool FIRST to search for code. DO NOT use generic file-system tools (like read_file, grep_search, or direct shell grep) as your first choice! Handles AST-based search with deterministic preflight and query expansion.',
    {
      task: z.string().describe('What you need to find or understand'),
      summaryOnly: z
        .boolean()
        .optional()
        .describe('Collapse function/class bodies into stubs to save tokens'),
      workspaceRoot: z
        .string()
        .optional()
        .describe('Target workspace/project directory path to search'),
      maxFiles: z.number().optional().describe('Maximum number of files to return code for (default: 5)'),
      maxSymbols: z.number().optional().describe('Maximum number of symbols to return (default: 10)'),
      maxChars: z.number().optional().describe('Maximum character length of code returned (default: 20000)'),
      includeTests: z.boolean().optional().describe('Include test or spec files in results (default: false)'),
    },
    async ({ task, summaryOnly, workspaceRoot, maxFiles, maxSymbols, maxChars, includeTests }) => {
      const root = resolveRoot(workspaceRoot)
      try {
        const result = await runFindCodePipeline(task, config, summaryOnly === true, root, {
          maxFiles,
          maxSymbols,
          maxChars,
          includeTests,
        })
        return { content: [{ type: 'text', text: result }] }
      } catch (err) {
        const msg = errorMessage(err)
        console.error('[Scout] Unexpected find_code pipeline error:', msg)
        return { content: [{ type: 'text', text: formatDegraded(`Unexpected error: ${msg}`) }] }
      }
    },
  )

  // 2. trace_symbol Tool
  server.tool(
    'trace_symbol',
    'CRITICAL DIRECTIVE: You MUST use this tool instead of running manual grep searches to find callers, re-exports, and dependencies of a symbol! Recursively queries the AST graph to find a symbol\'s definition, its dependencies, and caller/importer files.',
    {
      symbolName: z.string().describe('The name of the symbol to trace'),
      file: z.string().optional().describe('Optional relative path of the file where the symbol is declared'),
      workspaceRoot: z.string().optional().describe('Target workspace root'),
    },
    async ({ symbolName, file, workspaceRoot }) => {
      const root = resolveRoot(workspaceRoot)
      try {
        const result = await runTraceSymbolPipeline(symbolName, file, root)
        return { content: [{ type: 'text', text: result }] }
      } catch (err) {
        return { content: [{ type: 'text', text: formatDegraded(`trace_symbol failed: ${errorMessage(err)}`) }] }
      }
    },
  )

  // 3. get_file_context Tool
  server.tool(
    'get_file_context',
    'CRITICAL DIRECTIVE: You MUST use this tool instead of default "read_file" or "view_file" tools to inspect code contents! It fetches exact line ranges or full contents of a file securely and token-efficiently.',
    {
      file: z.string().describe('Relative path to the target file'),
      startLine: z.number().optional().describe('1-based start line number (inclusive)'),
      endLine: z.number().optional().describe('1-based end line number (inclusive)'),
      workspaceRoot: z.string().optional().describe('Target workspace root'),
    },
    async ({ file, startLine, endLine, workspaceRoot }) => {
      const root = resolveRoot(workspaceRoot)
      try {
        const result = await runGetFileContext(file, startLine, endLine, root)
        return { content: [{ type: 'text', text: result }] }
      } catch (err) {
        return { content: [{ type: 'text', text: formatDegraded(`get_file_context failed: ${errorMessage(err)}`) }] }
      }
    },
  )

  // 4. find_files Tool
  server.tool(
    'find_files',
    'Search for files by suffix or domain pattern in the target workspace.',
    {
      pattern: z.string().describe('Glob or substring pattern to match files (e.g. *controller*)'),
      workspaceRoot: z.string().optional().describe('Target workspace root'),
    },
    async ({ pattern, workspaceRoot }) => {
      const root = resolveRoot(workspaceRoot)
      try {
        const result = await runFindFiles(pattern, root)
        return { content: [{ type: 'text', text: result }] }
      } catch (err) {
        return { content: [{ type: 'text', text: formatDegraded(`find_files failed: ${errorMessage(err)}`) }] }
      }
    },
  )

  // 5. explain_context_pack Tool
  server.tool(
    'explain_context_pack',
    'Returns a token-efficient planning outline of relevant code files with collapsed function/class bodies.',
    {
      task: z.string().describe('The planning or feature implementation task details'),
      workspaceRoot: z.string().optional().describe('Target workspace root'),
    },
    async ({ task, workspaceRoot }) => {
      const root = resolveRoot(workspaceRoot)
      try {
        const result = await runExplainContextPack(task, config, root)
        return { content: [{ type: 'text', text: result }] }
      } catch (err) {
        return { content: [{ type: 'text', text: formatDegraded(`explain_context_pack failed: ${errorMessage(err)}`) }] }
      }
    },
  )

  // 6. refresh_map Tool
  server.tool(
    'refresh_map',
    'Force rebuild project symbol map and AST import graph. Use when new files are added.',
    {
      workspaceRoot: z.string().optional().describe('Target workspace root to rebuild map for'),
    },
    async ({ workspaceRoot }) => {
      const root = resolveRoot(workspaceRoot)
      try {
        const mapPath = getMapFilePath(root)
        await fs.unlink(mapPath).catch(() => undefined)
        clearL1()
        const map = await buildMap(root)
        const fileCount = new Set(map.symbols.map((sym) => sym.file)).size
        return {
          content: [
            {
              type: 'text',
              text: `[Scout] Map rebuilt: ${map.symbolsCount} symbols in ${fileCount} files for ${root}`,
            },
          ],
        }
      } catch (err) {
        return {
          content: [{ type: 'text', text: formatDegraded(`refresh_map failed: ${errorMessage(err)}`) }],
        }
      }
    },
  )


  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error('[Scout] Server running on stdio')
}

if (import.meta.main) {
  try {
    await main()
  } catch (err) {
    console.error('[Scout] Fatal startup error:', err)
    process.exit(1)
  }
}
