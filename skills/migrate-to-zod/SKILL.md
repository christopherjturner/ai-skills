---
name: migrate-to-zod
description: Migrates hand-rolled validation, date parsing, UUID/regex checks, and shape-guard functions to canonical Zod schemas while preserving runtime coercions and error contracts.
---

# Skill: Migrate Hand-Rolled Validators to Zod (`migrate-to-zod`)

Use this skill when refactoring hand-rolled validation/parsing logic (such as manual `typeof` guards, `Date.parse` / `new Date` checks, `YYYY-MM-DD` regexes, `UUID` regexes, or `*-vocab.ts` parsers) to Zod schemas.

## Hard Constraints

1. **Never use raw `z.coerce.date()` for calendar dates.** `z.coerce.date()` wraps `new Date(input)`, which silently rolls over invalid calendar dates like `"2026-02-31"` to March 3rd and accepts numbers/empty strings unexpectedly. Always use strict calendar/timestamp primitives from `@/core/schemas` (or `lib/schemas`).
2. **Never re-declare global primitives locally.** UUIDs (`UuidSchema`), calendar dates (`CalendarDateSchema`), ISO timestamps (`IsoTimestampSchema`), emails (`EmailSchema`), and empty-string coercions (`emptyToNull`) must be imported from the shared core schema module, never rewritten with inline regexes.
3. **Preserve existing failure modes and error messages.**
   - If a legacy function returns `{ ok: false, error: "Give the day it was received." }` or `{ error: "..." }`, map `safeParse` failures to that exact return shape and message.
   - If a legacy function throws a specific error class (e.g. `SecurityRefusal`), throw that exact class on `!parsed.success`.
   - If a legacy function returns `null` or `boolean`, preserve that return contract at the wrapper boundary until callers are migrated.
4. **Preserve silent input coercions unless proven dead.** Hand-rolled parsers frequently trim whitespace, normalize case, or treat `""` / `undefined` as `null`. Encode these explicitly with `.trim()`, `.toLowerCase()`, or `z.preprocess` / `emptyToNull()` so form and query-param callers do not regress.
5. **Stop and ask on intentional vs. accidental behaviour changes.** If the legacy validator has a clear bug (e.g., missing calendar rollover check on `"2026-02-31"`, or an unanchored regex `/^\d{4}-\d{2}-\d{2}/`), tighten it in the Zod schema and explicitly note the tightened edge case in your report.

---

## Execution Workflow

### Step 1: Run AST Discovery on the Target File or Module

Do not grep manually. Run the AST analyzer to inventory all hand-rolled validators, their failure modes, signals, and hidden coercions in the target file or directory:

```bash
npx tsx .agents/skills/migrate-to-zod/scripts/analyze-validators.ts <path/to/file-or-dir> --limit 50
```

Also run ESLint on the target path to surface inline `ordit/no-hand-rolled-dates` and `ordit/no-hand-rolled-primitives` warnings:

```bash
npx eslint <path/to/file-or-dir>
```

### Step 2: Classify Each Candidate Before Editing

For each candidate surfaced in Step 1, record:
1. **Input source:** JSON payload, `FormData`, query params, CSV/spreadsheet import, or DB driver row (`unknown`).
2. **Coercions present:** `.trim()`, `.toLowerCase()`, `"" -> null`, prefix stripping (e.g., `v2.0 -> 2.0`), or default values.
3. **Domain refinements:** Minimum/maximum dates (e.g. `>= "1990-01-01"`), timezone-relative bounds (e.g. "not in the future in UAE `Asia/Dubai` time"), or cross-field invariants (`start <= end`).
4. **Failure contract:** `returns-boolean` (`v is T`), `returns-null` (`T | null`), `returns-result` (`{ ok, ... }` / `{ error }`), or `throws`.

### Step 3: Compose Schemas from Core Primitives

1. **Reuse `@/core/schemas` (or `lib/schemas`) primitives first:**
   - `UuidSchema`: replaces `/^[0-9a-f]{8}-[0-9a-f]{4}-.../i` and local `isUuid` helpers.
   - `CalendarDateSchema`: strict `YYYY-MM-DD` validation that rejects non-existent calendar dates (`"2026-02-29"`, `"2026-02-31"`).
   - `IsoTimestampSchema`: strict ISO-8601 instant validation.
   - `emptyToNull(schema)`: wraps optional form/input strings where `""` or whitespace-only strings map to `null`.
2. **Add module-specific schemas in the module's `schema.ts` (or `*-vocab.ts`):**
   - Layer module-specific rules (such as date range bounds or custom user-facing error messages) using `.refine(...)` or `.superRefine(...)` on top of the core primitive rather than writing a new regex.
   - Export both the runtime schema (`FooInputSchema`) and the inferred type (`export type FooInput = z.infer<typeof FooInputSchema>`).

### Step 4: Verify Behavioral Equivalence on Edge Cases

Before deleting non-trivial legacy date or shape parsers, verify the new schema against the legacy implementation using a focused unit test (Vitest) covering:
- **Valid cases:** typical inputs, boundary dates (`"2024-02-29"` leap year, `"1990-01-01"`).
- **Coercion cases:** leading/trailing whitespace (`" 2026-05-01 "`), empty string `""`, `null`, `undefined`.
- **Adversarial / rollover cases:** `"2026-02-29"` (non-leap year), `"2026-02-31"` (month rollover), `"2026-13-01"`, `"2026-1-5"` (unpadded), `"2026-05-01T00:00:00Z"` (timestamp passed to calendar date), `NaN`, `0`, `{}`.

Run the scoped unit test:
```bash
npx vitest run <path/to/test.ts>
```

### Step 5: Replace & Push Validation to the Boundary

Choose the replacement strategy based on caller scope:

- **Case A — Module-internal or single-file callers:**
  1. Parse once at the module boundary (Server Action, Route Handler, or module entry point) using `Schema.safeParse(raw)`.
  2. Pass the parsed, strongly-typed output (`z.infer<typeof Schema>`) into internal domain/repo functions.
  3. Delete redundant inner defensive checks (`typeof`, `isUuid`, `isDate`) and remove the legacy helper.

- **Case B — Widely shared helper across many modules:**
  1. Replace the internal implementation of the existing function with `Schema.safeParse(...)` while keeping its exact function signature and return shape.
  2. Mark the wrapper `@deprecated Use <SchemaName> from '@/core/schemas'`.

### Step 6: Scoped Verification

1. Run ESLint on all modified files to confirm zero `ordit/no-hand-rolled-dates` and `ordit/no-hand-rolled-primitives` warnings remain in the migrated code:
   ```bash
   npx eslint <modified-files>
   ```
2. Run the relevant unit tests:
   ```bash
   npx vitest run <test-files>
   ```
3. Follow `ai-team/OPERATING_MODEL.md` (D-088) for any final typecheck (`npx tsc --noEmit`) when shared types or signatures change.
