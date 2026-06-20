<!-- Last updated: YYYY-MM-DD | Reason: Added MCP Scout section -->

<!-- scout:start -->

# MCP Scout — AST Code Intelligence (Priority: HIGHEST)

This project uses **MCP Scout** (`smarter-faster-better-mcp`) for AST-based code search and analysis. Scout tools must be used before any generic file-system tools.

## Tool Descriptions

| MCP Tool | Purpose | Priority |
| :--- | :--- | :--- |
| `scout_find_code` | **FIRST choice** for any code search — AST-based search with query expansion | **Highest** |
| `scout_trace_symbol` | Find callers, callees, imports, and dependencies of a symbol | **Highest** |
| `scout_get_file_context` | Read file contents — use instead of `read_file` or `view_file` | **Highest** |
| `scout_find_files` | Find files by pattern or suffix | **High** |
| `scout_refresh_map` | Rebuild project symbol map when new files are added | Medium |
| `scout_explain_context_pack` | Generate planning overview with collapsed code bodies | **High** |
| `scout_cleanup_workspace` | Clean temporary/build output from workspace | Low |

## Always Do

- **MUST use `scout_find_code` FIRST** for any code search or understanding task — never start with `grep`, `bash find`, or `Task`.
- **MUST use `scout_trace_symbol`** instead of `grep` to find callers, re-exports, and dependencies of a symbol.
- **MUST use `scout_get_file_context`** instead of `read_file` or `view_file` to inspect code contents.
- **MUST retry Scout tool calls at least once** if they fail or time out, before assuming Scout is unavailable.

## Never Do

- NEVER start code search with `grep`, `bash find`, or generic `read_file` when Scout is available.
- NEVER use `Task` tool for file exploration when a Scout MCP tool can do it faster.
- NEVER assume Scout is unavailable after a single failure — retry once first.

## Fallback Sequence

1. `scout_find_code` / `scout_trace_symbol` / `scout_get_file_context` (primary)
2. `Task` tool (secondary — only if Scout fails or times out)
3. `grep` / `bash find` / raw file reads (last resort)

<!-- scout:end -->
