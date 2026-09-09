BookOrbit sources: server/src/modules owns backend features; client/src/features owns UI/composables; packages/types owns shared wire contracts; packages/plugin-api owns plugin contracts.

- Read AGENTS.md for authoritative project instructions.
- See `mem:tech_stack` for runtime/build constraints, `mem:conventions` for repository invariants, `mem:suggested_commands` for development, and `mem:task_completion` for verification.
- See `mem:deployment` for the live host, shared database, persistent storage, and repository synchronization rules before infrastructure or database work.
- Assume tens of thousands of books per user. Use user-scoped queries, pagination/batching, targeted fields, indexes, bounded concurrency, and virtualized long lists. Avoid unbounded collection reads and N+1 queries. Bulk work needs progress, useful logs, and bounded memory.
- Library assets may be shared; personal progress, annotations, credentials and device state must retain user scoping.
