---
name: fix-max-exports
description: Refactor TypeScript files violating the max-exports ESLint rule by pruning internal-only exports and extracting cohesive symbol clusters into new modules.
---

# Fix `max-exports` Violations

When a TypeScript file triggers the `max-exports` ESLint rule, follow this step-by-step workflow to reduce the export count while keeping related code cohesive and avoiding circular dependencies.

## 1. Audit Current Exports
Identify all exported runtime values in the target file (`const`, `let`, `var`, `function`, `class`, `enum`, default exports, and re-exports). 
- Note: If `ignoreTypeExports` is enabled in ESLint, ignore `export interface` and `export type` declarations during your count, though you should still move them if their corresponding runtime values move.

## 2. Prune Internal-Only Exports (First Pass)
Before splitting the file, check if any exported symbols are only used within the file itself (or not used at all).

1. For each exported symbol, search the codebase (excluding the target file) for import references.
2. **Used only internally:** Remove the `export` keyword so the symbol becomes a module-private helper.
3. **Unused anywhere (dead code):** Confirm it is not part of a public package entry point (`index.ts`). If internal to the app, delete the declaration or remove `export`.
4. Recount the remaining exports. **Stop here if the file now passes the `max-exports` threshold.**

## 3. Analyze Cohesion & Internal Dependencies
If the file still exceeds the limit, map the relationships between all declarations in the file (both exported and private) to avoid creating chatty cross-file imports or circular dependencies:

1. **Build an internal call/reference graph:** Note which functions, classes, constants, and types reference one another inside the file.
2. **Identify cohesive clusters:** Group symbols that:
   - Share private helper functions, constants, or internal state.
   - Operate on the same domain entity or data structure.
   - Call each other directly.
3. **Rule of thumb:** Never split two symbols into separate files if doing so forces File A to import from File B *and* File B to import from File A (circular dependency). Keep tightly coupled symbols in the same cluster.

## 4. Select Candidates for Extraction
Choose which cluster(s) to move into a new file based on the following priority:

1. **Zero-dependency leaf utilities:** Pure helper functions or standalone constants that do not depend on anything else in the current file.
2. **Self-contained sub-features:** A group of 2–3 exports and their private helpers that work together but do not interact with the main responsibility of the file.
3. **Secondary classes/schemas:** Validation schemas (e.g., Zod), error classes, or configuration objects that support the main module but have distinct responsibilities.

*Tip: Keep the primary export (or the cluster with the highest number of external consumers across the codebase) in the original file to minimize import churn.*

## 5. Extract and Update Imports
1. **Create a descriptive module:** Name the new file based on its specific domain responsibility (e.g., `order-pricing.ts` or `date-formatters.ts` rather than a generic `utils2.ts` or `helpers.ts`).
2. **Move the cohesive cluster:** Move the selected exports **along with** their dedicated private helpers and associated TypeScript types/interfaces into the new file.
3. **Avoid barrel re-exports:** Do **not** re-export the moved symbols from the original file (`export { foo } from './new-file'`), as re-exports still count toward the `max-exports` limit.
4. **Update consumer imports:** Update all files in the codebase that imported the moved symbols so they import directly from the new module path.

## 6. Verify
1. Run ESLint on both the original file and the newly created file(s) to ensure neither violates `max-exports`.
2. Run the TypeScript compiler (`tsc --noEmit`) to verify all consumer import paths and type references resolve cleanly.

---

## Walkthrough Example

Suppose `max-exports` is configured with `max: 3`, and `order-service.ts` currently has **6 runtime exports**.

### Before (`order-service.ts` — 3 Exports, Fails Lint)

```typescript
export interface OrderItem {
  id: string;
  price: number;
  quantity: number;
}

// Export #1 (Only used inside this file by calculateSubtotal)
export const TAX_RATE = 0.08;

// Export #2 (Only used inside this file by submitOrder)
export function validateOrderItems(items: OrderItem[]): boolean {
  return items.length > 0 && items.every((i) => i.quantity > 0);
}

// Export #3
export function calculateSubtotal(items: OrderItem[]): number {
  return items.reduce((sum, item) => sum + item.price * item.quantity, 0);
}

// Export #4 (Calls calculateSubtotal & uses TAX_RATE)
export function calculateTotalWithTax(items: OrderItem[]): number {
  const subtotal = calculateSubtotal(items);
  return Number((subtotal * (1 + TAX_RATE)).toFixed(2));
}

// Export #5 (Uses validateOrderItems)
export async function submitOrder(items: OrderItem[]): Promise<string> {
  if (!validateOrderItems(items)) {
    throw new Error('Invalid order items');
  }
  return 'order_123';
}

// Export #6
export async function cancelOrder(orderId: string): Promise<boolean> {
  return orderId.startsWith('order_');
}

## Step-by-Step Analysis

1. Prune internal-only exports:
    * Searching the codebase shows TAX_RATE and validateOrderItems are never imported outside order-service.ts.
    * Removing export from both drops the export count from 6 to 4 (calculateSubtotal, calculateTotalWithTax, submitOrder, cancelOrder). We still exceed max: 3.

2. Map internal dependencies & clusters:
    * Cluster A (Order Lifecycle): submitOrder (depends on private validateOrderItems) and cancelOrder.
    * Cluster B (Order Pricing): calculateSubtotal and calculateTotalWithTax (depends on calculateSubtotal and private TAX_RATE).
    * Notice that Cluster A and Cluster B do not call each other—they only share the OrderItem type.

3. Extract Cluster B:
    * Moving calculateSubtotal, calculateTotalWithTax, and their private TAX_RATE constant together into order-pricing.ts means neither file needs to import runtime functions from the other.

## After Refactor

1. `order-service.ts` (2 Runtime Exports — Passes Lint)

```ts
export interface OrderItem {
  id: string;
  price: number;
  quantity: number;
}

// Pruned 'export' keyword: kept as private helper for submitOrder
function validateOrderItems(items: OrderItem[]): boolean {
  return items.length > 0 && items.every((i) => i.quantity > 0);
}

// Export #1
export async function submitOrder(items: OrderItem[]): Promise<string> {
  if (!validateOrderItems(items)) {
    throw new Error('Invalid order items');
  }
  return 'order_123';
}

// Export #2
export async function cancelOrder(orderId: string): Promise<boolean> {
  return orderId.startsWith('order_');
}
```

2. `order-pricing.ts` (2 Runtime Exports — Passes Lint)

```ts
import type { OrderItem } from './order-service';

// Pruned 'export' keyword and moved with its cluster
const TAX_RATE = 0.08;

// Export #1
export function calculateSubtotal(items: OrderItem[]): number {
  return items.reduce((sum, item) => sum + item.price * item.quantity, 0);
}

// Export #2 (Stays with calculateSubtotal so no cross-file runtime import is needed)
export function calculateTotalWithTax(items: OrderItem[]): number {
  const subtotal = calculateSubtotal(items);
  return Number((subtotal * (1 + TAX_RATE)).toFixed(2));
}
```
