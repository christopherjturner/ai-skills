---
name: resolve-max-file-size
description: Splits oversized TypeScript files violating the max-file-size ESLint rule into cohesive modules without altering function logic.
---

# Skill: Resolve `max-file-size` Violation

Use this skill when an ESLint `max-file-size` (or `max-lines`) violation is detected in a TypeScript file.

## Hard Constraints
1. **NEVER modify function implementations.** Do not refactor, simplify, or split individual functions.
2. **Abort on monolithic functions.** If a single declaration exceeds the file size limit on its own, **STOP IMMEDIATELY** and report to the user that the file cannot be split without refactoring function internals.
3. **Minimize new exports.** Cluster private helpers into the same target file as the exported functions that call them so they remain module-private.
4. **No barrel re-exports unless necessary.** Update all consumer imports across the codebase to point directly to the new file paths.

---

## Execution Workflow

### Step 1: Run Structural & Call-Graph Analysis

Do not read and count lines manually, and do **not** run a full-project `tsc --noEmit` before splitting (full-project `tsc` is heavyweight and unnecessary for single-file AST analysis). Run the analysis helper to get exact declaration line counts (excluding comments/whitespace) and the internal dependency graph:

```bash
npx tsx .agents/skills/resolve-max-file-size/scripts/analyze.ts <path/to/file.ts> --max-lines <limit>
```

Inspect the JSON output:
* If "abort": true is returned, halt immediately and report the oversized declaration to the user.
* Review each declaration's internalDeps (what it calls in this file) and referencedByInternal (what calls it in this file).

### Step 2: Plan Semantic Clusters & File Layout

Group declarations into cohesive target files based on domain responsibility and call-graph proximity:

1. Keep callers and private callees together: If exported function A is the only caller of non-exported function helperB, place both in the same target file so helperB does not need to be exported.

2. Choose the directory layout:
    * 1 to 2 new files: Create sibling files in the same directory (e.g., user-validation.ts).
    * 3 or more new files: Create a subdirectory named after the original file stem (e.g., splitting schema.ts creates schema/primitives.ts, schema/validators.ts, schema/parsers.ts). If the original file is completely emptied, remove it after extraction.
    * Verify that the sum of codeLines for every planned file is comfortably below --max-lines (leave ~15% headroom for import statements).

### Step 3: Execute Atomic Extraction

Write a migration plan JSON file (/tmp/extract-plan.json) mapping target file paths to the exact declaration names to move:

```json
{
  "sourceFile": "src/schema.ts",
  "moves": [
    {
      "targetFile": "src/schema/validators.ts",
      "declarations": ["validateUser", "validateEmailHelper"]
    },
    {
      "targetFile": "src/schema/parsers.ts",
      "declarations": ["parseSchema", "SchemaNode"]
    }
  ]
}
```

Run the automated ts-morph extraction tool:

```bash
npx tsx .agents/skills/resolve-max-file-size/scripts/extract.ts /tmp/extract-plan.json
```

This script automatically (without loading the full `tsconfig.json` program):

* Moves the exact AST nodes without altering their bodies.
* Adds `export` only if another file (or the remaining source file) references that symbol.
* Copies only the external imports required by each new file (preserving `@/` path aliases and `type` modifiers).
* Rewrites all import/re-export paths across consumer files in the repository to point to the new locations.

### Step 4: Post-Flight Verification

Run ESLint on all touched and newly created files to verify the `max-lines` / `max-file-size` rule and import rules pass:

```bash
npx eslint <modified-and-new-files>
```

Only run full type-checking (`NODE_OPTIONS=--max-old-space-size=12288 npm run typecheck`) once at the end of the overall delivery unit if required by the task tier.

