# Changelog

All notable changes to the **MCP Scout** (`smarter-faster-better-mcp`) project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.9.0] - 2026-08-30

### Added
- **Dead Code Detection (`dead_code` / `scout_dead_code`)**:
  - Full AST dependency & reachability graph traversal from project entrypoints.
  - Automatically identifies unreachable/orphan files, unused named exports, and isolated dead cycles.
  - Smart entrypoint resolution from `package.json` (`main`, `bin`, `exports`), configuration files, and custom arguments.
- **Louvain Community Subsystem Clustering (`subsystem_clusters` / `scout_cluster_subsystems`)**:
  - Pure TypeScript, zero-dependency Louvain modularity optimization algorithm.
  - Discovers high-cohesion architectural subsystems, modules, and domain boundaries on weighted AST dependency graphs.
  - Computes modularity score ($Q$), internal cohesion ratios, and inter-subsystem coupling paths.
  - Automatic subsystem taxonomy and domain naming based on directory hierarchy and keyword extraction.
- Unit & integration tests for Dead Code Detection and Louvain Community Clustering.

---

## [0.8.3] - 2026-08-29

### Added
- **Zero-Config / Offline AST Mode**: Server no longer requires `SCOUT_BASE_URL`, `SCOUT_API_KEY`, or `SCOUT_MODEL` to run. AST search, import tracing, file slicing, and dependency analysis operate fully offline out of the box.
- **Dual Tool Registration (Aliases)**: Registered both primary tool names (`find_code`, `trace_symbol`, `get_file_context`, `find_files`, `blast_radius`, `explain_context_pack`, `refresh_map`, `cleanup_workspace`) and prefix aliases (`scout_find_code`, `scout_trace_symbol`, etc.) for seamless compatibility across various agent prompt templates.
- **Smart Workspace Root Auto-Discovery**: Automatically discovers the project root from the current working directory by searching for standard project markers (`.git`, `package.json`, `Cargo.toml`, `go.mod`, `pyproject.toml`, etc.) and environment variables (`SCOUT_WORKSPACE_ROOT`, `WORKSPACE_ROOT`).
- **Auto-Detect Parser Mode (`auto`)**: Automatically switches to Tree-sitter for polyglot repositories (Python, Go, Rust, Java, C++, PHP, Dart) while retaining maximum OXC speed for TypeScript/JavaScript files.

### Changed
- Refined MCP tool descriptions to replace legacy uppercase directives with clean, semantic capability definitions.
- Updated `AGENTS.template.md` and `README.md` to reflect Zero-Config mode and dual naming.

---

### Added
- **Query Analysis** (`query-analyzer.ts`): LLM-powered query analysis that classifies intent (specificSymbol, featureSearch, conceptSearch, fileSearch), extracts symbol names, expanded search terms, and file patterns before searching. Runs as the first step of the `find_code` pipeline with a 5s timeout and graceful fallback on failure.
- **Content Validation** (`content-validator.ts`): Post-extraction validation that checks whether extracted code actually matches the user's query. Two-layer approach: deterministic keyword scoring (instant) + LLM batch validation for borderline cases. Skipped for high-confidence deterministic matches to avoid unnecessary LLM calls.
- **Shared LLM Client** (`llm-client.ts`): Extracted common LLM fetch boilerplate (endpoint building, Authorization header, timeout management, error handling) into a reusable `llmFetch()` function. Used by query analyzer, content validator, and main LLM client.
- Integration tests for the full 4-step pipeline: query analysis → deterministic matching → LLM ranking → content validation.
- Read-only contract documentation: MCP Scout never modifies user source code; only writes to its own cache (`.project_map.json`, `.scout-cache/`).

### Changed
- `find_code` pipeline now has 4 explicit steps: (1) query analysis, (2) deterministic matching enhanced with analysis, (3) LLM-assisted ranking with analysis context, (4) content validation.
- `filterMap` and `getDeterministicMatches` accept optional `QueryAnalysis` to boost relevant symbols via expanded terms, file patterns, and symbol name matching.
- `askCheapLLM` receives query analysis context to improve LLM symbol ranking.
- System prompt updated to instruct LLM to use query hints for broader semantic matching.
- Architecture diagram and tool descriptions updated in README.

---

## [0.5.5] - 2026-05-27

### Changed
- Refactored `cleanupWorkspace` to be strictly non-destructive for user files: it now ONLY removes Scout's own generated files (`.scout-cache` and `.project_map.json`) during cleanup. It will never touch user build outputs (`dist`, `build`, etc.), configurations, or hidden system folders.
- Completely removed automatic workspace cleanup from executing in the background on startup to guarantee zero invasive file deletions.

## [0.5.4] - 2026-05-27

### Fixed
- Suppressed `dotenv` v17's console logging (`◇ injected env...`) by passing `quiet: true`. This prevents non-JSON characters from polluting the standard output (`stdout`), fixing MCP connection crashes under `bunx` / `bun` runtimes.
- Protected the `.git` directory from being accidentally removed during automatic workspace cleanup by designating it as a critical folder.

## [0.5.3] - 2026-05-27

### Fixed
- Prevented automatic workspace cleanup from executing when the resolved directory is the filesystem root (`/`) or the user's home directory. This fixes permission errors and prevents system/dotfile cleanup from crashing the MCP server on startup.

### Fixed
- Corrected the packaged MCP entrypoint so `bunx smarter-faster-better-mcp` resolves the bundled `package.json` from the published package root instead of walking outside the package.

### Added
- Added a packed-entry verification step that imports the tarballed `dist/index.js` before publish, preventing broken npm releases caused by stale or misbuilt artifacts.

---

## [0.4.0] - 2026-05-25

### Added
- Standard `.env` auto-loading integration using the official `dotenv` library.
- Automatic lookup of `.env` files in the current working directory (`process.cwd()`), enabling project-specific configurations.

### Changed
- Simplified client integration setup (Claude Desktop, Cursor, Windsurf, Claude Code) by eliminating the need to declare an `"env"` block inside the client configuration itself.
- Updated `README.md` to document the new `.env` workflow as the recommended primary setup approach.

---

## [0.3.2] - 2026-05-23

### Changed
- Minor bug fixes and configuration improvements for npm distribution packaging.

---

## [0.3.1] - 2026-05-23

### Added
- Comprehensive architecture and parser selection guide to `README.md`.
- Expanded documentation detailing the performance differences between the default Rust-based `oxc` parser and the optional polyglot `tree-sitter` parser.

---

## [0.3.0] - 2026-05-23

### Added
- Switched bundler to `bun build` to compile ultra-efficient ES module distribution outputs.
- Added GitHub Actions CI/CD workflows with automated npm packaging and provenance verification.

### Changed
- **Refactoring & Code Quality**: Applied strict code review standards across all core entrypoints. Decohesion eliminated, type safety increased (zero use of `any`), and ensured all core bootloader files are ultra-lean (<50 lines).

---

## [0.2.1] - 2026-05-23

### Added
- Embed anti-grep directives directly into tool descriptions to prevent AI agents from bypassing AST search for local stubs.
- Improved preflight string matching rules to prevent LLM hallucination on generic keywords and JSON properties.

---

## [0.2.0] - 2026-05-23

### Added
- **Multi-Pipeline System**: Implemented decoupled shared domain objects and tracing components.
- Modular, decoupled tools architecture: every tool registration (e.g. `find_code`, `trace_symbol`, `explain_context_pack`) is isolated in its own file.
- Tracing tools for AST graph symbol resolution to recursively find callers and import paths.

---

## [0.1.5] - 2026-05-23

### Added
- Support for parsing `.js` and `.jsx` files in addition to TypeScript.

---

## [0.1.4] - 2026-05-23

### Fixed
- Filtering logic to clean up LLM-hallucinated symbols and reduce extraction fallback rates.

---

## [0.1.3] - 2026-05-23

### Changed
- Enhanced local keywords filter to optimize memory cache lookup.

---

## [0.1.2] - 2026-05-23

### Changed
- Performance tuning for the AST-based search mapping.

---

## [0.1.1] - 2026-05-23

### Added
- Robust API error handling and LLM retry logic on communication timeouts.

---

## [0.1.0] - 2026-05-23

### Added
- **Initial Release**: High-performance AST-based MCP code search server via `oxc-parser`.
- Support for TypeScript (`.ts`, `.tsx`) and JSON (`.json`) files.
