# BookOrbit

Book/library management with Kobo support. pnpm monorepo: `server/` (NestJS 11 + Fastify), `client/` (Vue 3), `packages/types/` (shared contracts). Requires Node >= 24 and pnpm >= 11; use the version pinned in `package.json`.

## Workflow

- Fetch `origin` before work. Preserve existing changes on a feature branch and push verified work without overwriting remote changes. Fork: `git@github.com:CamilleHbp/bookorbit.git`.
- For issue-linked branches, use `BO-<issue-number>-<description>`. Follow [commit guidelines](docs/COMMIT_GUIDELINES.md). Never add `Co-authored-by` trailers.
- Match existing patterns. Keep modules focused; cross module boundaries through exported services or shared interfaces, not internal implementations.
- Share API types through `@bookorbit/types`; do not duplicate them in server and client.
- Comment only to explain non-obvious decisions. Never use em dashes in code, UI, documentation, or commit/PR text.

## Production and data safety

- Live app: `https://books.camille.studio`, host: `ssh nf-showcases`. Missing local Docker or `server/.env` is not evidence that the service/database is unavailable; inspect this host first.
- Deployment lives at `/home/debian/HomeServer` on that host; read its `AGENTS.md` before deployment operations. Local counterpart: `/Users/camille/Dev/Personal/HomeServer`. Do not deploy incomplete features.
- Use the shared HomeServer PostgreSQL service with BookOrbit's own database and role. Never add another PostgreSQL container. Run migration/integration tests in an isolated database, never destructive fixtures against live `bookorbit`.
- Persistent files: `/srv/homeserver/data/bookorbit`. Inspect Compose and mounts before changing storage. Never recursively change shared storage ownership or permissions.

## Access and scale

- User-owned data requires a `userId` FK and user-scoped queries. Controllers pass `@CurrentUser()` to services; services check ownership and throw `ForbiddenException`. Superuser bypasses follow `SmartScopeService`.
- Gate sensitive/destructive endpoints with `@RequirePermission(...)`. Enforce superuser-only restrictions server-side. No cross-user queries without an explicit superuser guard.
- UI visibility uses specific permissions through `usePermissions()`, not just `isSuperuser`. Hide or disable actions the backend would reject.
- Design for tens of thousands of books per user: paginate/batch queries, select needed fields, index appropriately, bound concurrency and memory, and virtualize long lists. Avoid N+1 queries and full-library loading or frontend processing.
- Bulk work needs progress, useful logs, and resumable or idempotent behavior where practical.

## Backend and database

- API prefix: `/api/v1`. Feature modules live in `server/src/modules/` with controller, service, module, and `dto/`. Controllers handle HTTP; services own business logic and feature database access. Shared guards, filters, pipes, and utilities belong in `server/src/common/`.
- Use constructor injection and `@Inject(DB)` for Drizzle. Inject typed `appConfig`, `dbConfig`, or `authConfig`; never read `process.env` in services.
- Validate DTOs with `class-validator`. Global validation transforms input and rejects unknown fields (`whitelist`, `forbidNonWhitelisted`). Throw NestJS `HttpException` subclasses, not raw `Error`; the global filter handles responses.
- Drizzle schemas live in `server/src/db/schema/`, re-exported from `index.ts`. Use `pgTable()` and inferred `$inferSelect` / `$inferInsert` types, not handwritten row types.
- For schema changes, edit the relevant schema file, run `pnpm --dir server db:generate`, then `pnpm --dir server db:migrate` against the intended database. Never hand-write migration SQL.
- Tests: Vitest (`vi.*`, never `jest.*`) and `@nestjs/testing` with `Test.createTestingModule()`. Use `.test.ts`; integration/E2E tests live in `server/test/`.

## Logging

- Format: `[event] [phase] key=value ... - short message`. Keep one event per operation and use `[start]`, `[end]`, `[fail]`, never dotted phases.
- Log these phases for external calls, batches, filesystem work, multi-step database work, background jobs, and destructive operations. Avoid start/end noise in simple reads and per-item hot loops; log failures or threshold-based slow reads.
- Fields, in order: IDs, inputs, outcomes/errors. Start includes IDs and input flags; end includes IDs, `durationMs`, and outcome counters; failure includes IDs, `durationMs`, `errorClass`, and a short `error="..."`.
- Keep logs single-line. Never log secrets, tokens, raw DTOs, or large blobs. Escape every dynamic quoted value with `sanitizeLogValue()` from `server/src/common/utils/log-sanitize.utils`; never use ad hoc escaping.

## Frontend

- Use `<script setup lang="ts">`, typed `defineProps` / `defineEmits`, and composables in `features/<name>/composables/use*.ts` for state/business logic. Components own layout and interaction; complex template expressions belong in computed properties. Prefer composables over feature-local Pinia stores.
- Event handlers must be named references: `@click="handleFoo"`. No inline calls or arrows, except `v-for` callbacks that need the item argument. ESLint enforces this.
- Use native `fetch`, Tailwind v4 utilities, and theme tokens from `src/assets/main.css`. No hardcoded colors or additional HTTP/icon libraries; use the installed `@lucide/vue` package.
- Lazy-load route components in `src/router/index.ts`. Support mobile and desktop. Test with Vitest and `@vue/test-utils`.

## User-facing copy

- Use short, plain labels and direct actions/outcomes. Remove help that repeats the controls or narrates the workflow.
- Explain only what helps users choose, enter valid input, understand a consequence, or recover from an error. Put guidance beside the relevant control or show it when needed.
- Keep implementation, storage, configuration precedence, and job orchestration out of UI copy. Describe sources by their content, not adapter/preset behavior or speculative access caveats. Apply this to translations and errors too.
- Deliverable documents contain audience material only, with appropriate citations/credits. Keep process, scope, confidence, and production notes in chat unless requested.

## Verification

- Run the smallest relevant tests, typecheck, lint, or build. Before committing, format changed files with Prettier and run ESLint for affected code. Fix failures; report skipped checks and why.
- For API changes, verify the frontend method/path, request fields and types, backend DTO validation, response shape, and permission checks together.
- Root commands: `pnpm verify:fast` (lint + typecheck), `pnpm test`, `pnpm dev`. Use workspace scripts for targeted checks.
- Local development uses `docker-compose.dev.yml` for PostgreSQL and native `pnpm dev`. Production image/Compose definitions are `Dockerfile` and `docker-compose.yml`; actual live deployment is managed by HomeServer above.
