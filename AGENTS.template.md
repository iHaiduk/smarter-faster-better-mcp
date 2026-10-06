<!-- Last updated: YYYY-MM-DD | Reason: Added MCP Scout section -->

<!-- scout:start -->

# MCP Scout — AST Code Intelligence (Priority: HIGHEST)

This project uses **MCP Scout** (`smarter-faster-better-mcp`) for AST-based code search and analysis. Scout tools must be used before any generic file-system tools.

## Tool Descriptions

| MCP Tool | Purpose | Priority |
| :--- | :--- | :--- |
| `scout_triage` | **Dynamic AI hypothesis & candidate triage** — evaluates caller-defined criteria via TypeSafe Jev (System 1) | **Highest** |
| `find_code` (or `scout_find_code`) | **Exact & semantic code search** — AST-based search with symbol extraction | **Highest** |
| `trace_symbol` (or `scout_trace_symbol`) | Trace callers, callees, imports, and dependencies of a symbol | **Highest** |
| `get_file_context` (or `scout_get_file_context`) | Inspect code slices with resolved imports & type definitions | **Highest** |
| `blast_radius` (or `scout_blast_radius`) | Analyze affected dependencies and call flows before refactoring | **High** |
| `dead_code` (or `scout_dead_code`) | Detect unreachable files, dead exports, and dead islands | **High** |
| `subsystem_clusters` (or `scout_cluster_subsystems`) | Louvain community detection of modular subsystems & domains | **High** |
| `find_files` (or `scout_find_files`) | Fast glob file search with smart ignore filters | **High** |
| `explain_context_pack` (or `scout_explain_context_pack`) | Generate planning overview with collapsed code bodies | **High** |
| `refresh_map` (or `scout_refresh_map`) | Force rebuild project symbol map when files change | Medium |
| `cleanup_workspace` (or `scout_cleanup_workspace`) | Clean temporary cache/build outputs | Low |

## Decision Matrix: What to call and when

- **Call `scout_triage` FIRST when**:
  - You need to filter candidates based on architectural or domain hypotheses (e.g., *"Is this an entrypoint?"*, *"Does this touch billing or auth?"*).
  - You have multiple candidate files (>2) and want to avoid reading full files or polluting your context window.
  - You define dynamic questions (`check`, `classify`, `score`) tailored to the user's specific request.
- **Call `find_code` when**:
  - You are looking for a specific function, class, or identifier by name or standard search query.
- **Call `get_file_context` when**:
  - You have narrowed down the file and need precise line ranges (`startLine` / `endLine`) without reading the whole file.
- **Call `trace_symbol` when**:
  - You need to know who calls a function or what a module imports.
- **Call `blast_radius` when**:
  - You are about to refactor or delete shared code.

## Always Do

- **Prefer `scout_triage` & `find_code`** for any code search or architecture understanding before calling native file readers.
- **Formulate dynamic criteria in `scout_triage`** using specific `check` questions (e.g. `{"is_entrypoint": {"type": "check", "question": "..."}}`) to get sub-second probability scores.
- **Use `trace_symbol` (or `scout_trace_symbol`)** to inspect symbol references, call chains, and re-exports.
- **Use `get_file_context` (or `scout_get_file_context`)** to read precise code slices with resolved types.
- **Use `blast_radius` (or `scout_blast_radius`)** before refactoring or deleting shared functions.
- **Use `dead_code` (or `scout_dead_code`)** before cleaning up codebase to detect unused exports and orphan files.
- **Use `subsystem_clusters` (or `scout_cluster_subsystems`)** to understand macro-architecture and domain boundaries.

## Fallback Sequence

1. `scout_triage` / `find_code` / `trace_symbol` / `get_file_context` (primary AST & System-1 tools)
2. `find_files` / `refresh_map` (file navigation & index sync)
3. `grep` / raw file reads (fallback ONLY if MCP server is completely unreachable)

<!-- scout:end -->
