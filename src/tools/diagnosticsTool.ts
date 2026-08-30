import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { TypeScriptDiagnosticsService } from '../lsp/ts-diagnostics.js'

let diagnosticsService: TypeScriptDiagnosticsService | null = null

export function getDiagnosticsService(targetRoot = process.cwd()): TypeScriptDiagnosticsService {
  if (!diagnosticsService) {
    diagnosticsService = new TypeScriptDiagnosticsService(targetRoot)
  }
  return diagnosticsService
}

export function registerDiagnosticsTool(server: McpServer): void {
  server.registerTool(
    'get_diagnostics',
    {
      description:
        'Retrieves live LSP & compiler diagnostics (type errors, syntax errors, unresolved imports) for TypeScript and JavaScript files in the workspace.',
      inputSchema: {
        file: z
          .string()
          .optional()
          .describe('Relative or absolute file path to check. If omitted, checks all workspace source files.'),
        severity: z
          .enum(['error', 'warning', 'all'])
          .optional()
          .default('all')
          .describe('Filter diagnostics by severity level (default: all).'),
        limit: z
          .number()
          .optional()
          .default(50)
          .describe('Maximum number of diagnostics to return (default: 50).'),
        targetRoot: z
          .string()
          .optional()
          .describe('Root directory of the project (defaults to process.cwd()).'),
      },
    },
    async (args) => {
      try {
        const root = args.targetRoot || process.cwd()
        const service = getDiagnosticsService(root)
        const items = await service.getDiagnostics({
          file: args.file,
          severity: args.severity,
          limit: args.limit,
        })

        if (items.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    status: 'clean',
                    message: 'No diagnostics or type errors found.',
                    diagnosticsCount: 0,
                    diagnostics: [],
                  },
                  null,
                  2,
                ),
              },
            ],
          }
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  status: 'issues_found',
                  diagnosticsCount: items.length,
                  diagnostics: items,
                },
                null,
                2,
              ),
            },
          ],
        }
      } catch (err) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  status: 'error',
                  error: err instanceof Error ? err.message : String(err),
                },
                null,
                2,
              ),
            },
          ],
          isError: true,
        }
      }
    },
  )
}
