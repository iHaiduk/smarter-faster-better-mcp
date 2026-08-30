<!-- Last updated: YYYY-MM-DD | Reason: Added MCP Scout section -->

<!-- scout:start -->

# MCP Scout — AST Code Intelligence (Priority: HIGHEST)

This project uses **MCP Scout** (`smarter-faster-better-mcp`) for AST-based code search and analysis. Scout tools must be used before any generic file-system tools.

## Tool Descriptions

| MCP Tool | Purpose | Priority |
| :--- | :--- | :--- |
| `find_code` (or `scout_find_code`) | **Primary search** — AST-based code search with query expansion | **Highest** |
| `trace_symbol` (or `scout_trace_symbol`) | Trace callers, callees, imports, and dependencies of a symbol | **Highest** |
| `get_file_context` (or `scout_get_file_context`) | Inspect code slices with resolved imports & type definitions | **Highest** |
| `blast_radius` (or `scout_blast_radius`) | Analyze affected dependencies and call flows before refactoring | **High** |
| `dead_code` (or `scout_dead_code`) | Detect unreachable files, dead exports, and dead islands | **High** |
| `subsystem_clusters` (or `scout_cluster_subsystems`) | Louvain community detection of modular subsystems & domains | **High** |
| `find_files` (or `scout_find_files`) | Fast glob file search with smart ignore filters | **High** |
| `explain_context_pack` (or `scout_explain_context_pack`) | Generate planning overview with collapsed code bodies | **High** |
| `refresh_map` (or `scout_refresh_map`) | Force rebuild project symbol map when files change | Medium |
| `cleanup_workspace` (or `scout_cleanup_workspace`) | Clean temporary cache/build outputs | Low |

## Always Do

- **Prefer `find_code` (or `scout_find_code`)** for any code search or architecture understanding.
- **Use `trace_symbol` (or `scout_trace_symbol`)** to inspect symbol references, call chains, and re-exports.
- **Use `get_file_context` (or `scout_get_file_context`)** to read precise code slices with resolved types.
- **Use `blast_radius` (or `scout_blast_radius`)** before refactoring or deleting shared functions.
- **Use `dead_code` (or `scout_dead_code`)** before cleaning up codebase to detect unused exports and orphan files.
- **Use `subsystem_clusters` (or `scout_cluster_subsystems`)** to understand macro-architecture and domain boundaries.

## Fallback Sequence

1. `find_code` / `trace_symbol` / `get_file_context` (primary AST tools)
2. `find_files` / `refresh_map` (file navigation & index sync)
3. `grep` / raw file reads (fallback if symbol is unindexed)

<!-- scout:end -->
