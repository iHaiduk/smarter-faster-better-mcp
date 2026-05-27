# Changelog

All notable changes to the **MCP Scout** (`smarter-faster-better-mcp`) project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.5.2] - 2026-05-27

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
