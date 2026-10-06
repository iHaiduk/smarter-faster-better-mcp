import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import type { ScoutConfig, DynamicCriterion } from '../shared/types/index.js'
import { runDynamicTriage } from '../extraction/jev/dynamic-triage.js'
import { resolveWorkspaceRoot } from '../shared/fs/resolveWorkspaceRoot.js'
import { errorMessage } from '../shared/errors/errorMessage.js'

const DESCRIPTION =
  'Universal, dynamic AI-to-code triage tool. Evaluates arbitrary criteria/questions formulated on the fly by the calling AI model against AST-extracted file candidates without hardcoded taxonomies.'

const CRITERION_SCHEMA = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('check'),
    question: z.string().describe('The binary verification question to ask about the code candidate'),
    yesMeans: z.string().optional().describe('Description of what a positive condition means'),
    noMeans: z.string().optional().describe('Description of what a negative condition means'),
  }),
  z.object({
    type: z.literal('classify'),
    question: z.string().describe('The categorical judgment to make among caller-provided options'),
    options: z.record(z.string(), z.string()).describe('Map of option keys to their semantic definitions'),
    actAbove: z.number().optional().describe('Confidence threshold to act, default 0.8'),
  }),
  z.object({
    type: z.literal('score'),
    criterion: z.string().describe('The rating criteria along an ordered rubric'),
    levels: z.record(z.string(), z.string()).describe('Map of score levels, lowest to highest'),
  }),
])

const SCHEMA = {
  intent: z.string().describe('Natural language description of what the calling AI is looking for'),
  searchHints: z.array(z.string()).optional().describe('Keywords, symbol fragments or domain hints for coarse AST filtering'),
  candidateFiles: z.array(z.string()).optional().describe('Specific candidate file paths if already known, or omit to auto-discover'),
  criteria: z.record(z.string(), CRITERION_SCHEMA).describe('Dynamic questions and evaluation criteria formulated by the calling AI'),
  minConfidence: z.number().optional().describe('Minimum combined confidence score to include candidate in response (default: 0.5)'),
  limit: z.number().optional().describe('Maximum number of candidates to evaluate (default: 8)'),
  workspaceRoot: z.string().optional().describe('Target project root directory path (defaults to auto-detected project root)'),
}

export function registerDynamicTriageTool(server: McpServer, config: ScoutConfig): void {
  const handler = async (args: {
    intent: string
    searchHints?: string[]
    candidateFiles?: string[]
    criteria: Record<string, z.infer<typeof CRITERION_SCHEMA>>
    minConfidence?: number
    limit?: number
    workspaceRoot?: string
  }) => {
    const root = resolveWorkspaceRoot(args.workspaceRoot)
    try {
      const response = await runDynamicTriage(
        {
          intent: args.intent,
          searchHints: args.searchHints,
          candidateFiles: args.candidateFiles,
          criteria: args.criteria as Record<string, DynamicCriterion>,
          minConfidence: args.minConfidence,
          limit: args.limit,
          workspaceRoot: root,
        },
        config,
        root,
      )

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(response, null, 2),
          },
        ],
      }
    } catch (err) {
      const errorMsg = errorMessage(err)
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              error: `scout_triage failed: ${errorMsg}`,
              intent: args.intent,
              matches: [],
            }),
          },
        ],
      }
    }
  }

  server.tool('scout_triage', DESCRIPTION, SCHEMA, handler)
}
