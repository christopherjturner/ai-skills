/**
 * Custom ESLint Rule: ordit/no-hand-rolled-primitives
 *
 * Detects hand-rolled validation primitives and copy-pasted coercion helpers:
 * 1. Inline UUID regexes (/^[0-9a-f]{8}-[0-9a-f]{4}-.../i)
 * 2. Inline Email regexes (/^[^\s@]+@[^\s@]+\.[^\s@]+$/)
 * 3. Re-declared local coercion/error helpers (pgCode, pgError, iso, isoOf, asText, isUuid, isIsoDate, isCalendarDate)
 * 4. Hand-rolled object shape validators (functions taking `unknown` with 3+ `typeof` checks)
 *
 * Performance Architecture:
 * - Zero TypeScript type-checker (`parserServices`) usage.
 * - O(1) file-level regex bailout on `context.sourceCode.text`.
 * - Scoped counter stack for `typeof` checks per function (single pass, no sub-tree re-walks).
 */

const FILE_PRECHECK_REGEX =
  /\[0-9a-f\]\{8\}-|[^\s@]+@[^\s@]+|\b(?:pgCode|pgError|iso|isoOf|asText|isUuid|isIsoDate|isCalendarDate)\b|\btypeof\b/i;

const UUID_REGEX_PATTERN = /\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}/i;
const EMAIL_REGEX_PATTERN =
  /\[\^\\s@\]\+@\[\^\\s@\]\+\\.\[\^\\s@\]\+|\\S\+@\\S\+\\.\\S\+/;

const DUPLICATE_HELPER_NAMES = new Set([
  "pgCode",
  "pgError",
  "iso",
  "isoOf",
  "asText",
  "isUuid",
  "isIsoDate",
  "isCalendarDate",
]);

const PRIMITIVE_TYPEOF_LITERALS = new Set([
  "string",
  "number",
  "boolean",
  "object",
]);

function hasUntrustedParam(fnNode) {
  for (const param of fnNode.params) {
    const typeAnnotation =
      param.type === "AssignmentPattern"
        ? param.left.typeAnnotation?.typeAnnotation
        : param.typeAnnotation?.typeAnnotation;

    if (!typeAnnotation) continue;
    if (
      typeAnnotation.type === "TSUnknownKeyword" ||
      typeAnnotation.type === "TSAnyKeyword"
    ) {
      return true;
    }
    // Check Record<string, unknown>
    if (
      typeAnnotation.type === "TSTypeReference" &&
      typeAnnotation.typeName?.type === "Identifier" &&
      typeAnnotation.typeName.name === "Record"
    ) {
      const typeArgs = typeAnnotation.typeArguments?.params || typeAnnotation.typeParameters?.params;
      if (
        typeArgs &&
        typeArgs.length === 2 &&
        (typeArgs[1].type === "TSUnknownKeyword" || typeArgs[1].type === "TSAnyKeyword")
      ) {
        return true;
      }
    }
  }
  return false;
}

function getFunctionName(fnNode) {
  if (fnNode.id?.type === "Identifier") {
    return fnNode.id.name;
  }
  const parent = fnNode.parent;
  if (parent?.type === "VariableDeclarator" && parent.id?.type === "Identifier") {
    return parent.id.name;
  }
  if (parent?.type === "Property" && parent.key?.type === "Identifier") {
    return parent.key.name;
  }
  return null;
}

/** @type {import("eslint").Rule.RuleModule} */
export const noHandRolledPrimitivesRule = {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow hand-rolled UUID/email regexes, duplicated coercion helpers, and manual typeof shape validators in favor of Zod schemas and shared core helpers.",
    },
    schema: [
      {
        type: "object",
        properties: {
          maxTypeofGuardsInUntrustedFn: { type: "integer", minimum: 2 },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      noUuidRegex:
        "Hand-rolled UUID regex '{{pattern}}' detected. Use UuidSchema (z.string().uuid()) from '@/core/schemas' instead.",
      noEmailRegex:
        "Hand-rolled email regex '{{pattern}}' detected. Use EmailSchema (z.string().email()) from '@/core/schemas' instead.",
      noDuplicateHelper:
        "Local helper '{{name}}' duplicates a common parser/coercion pattern. Import a shared helper or Zod schema from '@/core' instead of redefining it per file.",
      noManualShapeValidator:
        "Function '{{name}}' performs {{count}} manual typeof guards on untrusted input. Replace hand-rolled shape validation with a Zod schema.",
    },
  },

  create(context) {
    const rawText = context.sourceCode.text;

    if (!FILE_PRECHECK_REGEX.test(rawText)) {
      return {};
    }

    const maxTypeofGuards =
      context.options[0]?.maxTypeofGuardsInUntrustedFn ?? 3;

    // Single-pass stack to count `typeof x === "..."` per function without re-traversing subtrees
    const fnStack = [];

    function enterFunction(node) {
      const name = getFunctionName(node);
      if (name && DUPLICATE_HELPER_NAMES.has(name)) {
        context.report({
          node: node.id || node.parent?.id || node,
          messageId: "noDuplicateHelper",
          data: { name },
        });
      }

      fnStack.push({
        node,
        name: name || "<anonymous>",
        acceptsUntrusted: hasUntrustedParam(node),
        typeofCount: 0,
      });
    }

    function exitFunction() {
      const current = fnStack.pop();
      if (
        current &&
        current.acceptsUntrusted &&
        current.typeofCount >= maxTypeofGuards
      ) {
        context.report({
          node: current.node.id || current.node.parent?.id || current.node,
          messageId: "noManualShapeValidator",
          data: {
            name: current.name,
            count: String(current.typeofCount),
          },
        });
      }
    }

    return {
      FunctionDeclaration: enterFunction,
      "FunctionDeclaration:exit": exitFunction,
      FunctionExpression: enterFunction,
      "FunctionExpression:exit": exitFunction,
      ArrowFunctionExpression: enterFunction,
      "ArrowFunctionExpression:exit": exitFunction,

      // 1 & 2. Catch inline UUID and Email regexes
      Literal(node) {
        if (!node.regex) return;
        const { pattern, flags } = node.regex;

        if (UUID_REGEX_PATTERN.test(pattern)) {
          context.report({
            node,
            messageId: "noUuidRegex",
            data: { pattern: `/${pattern}/${flags}` },
          });
          return;
        }

        if (EMAIL_REGEX_PATTERN.test(pattern)) {
          context.report({
            node,
            messageId: "noEmailRegex",
            data: { pattern: `/${pattern}/${flags}` },
          });
        }
      },

      // 4. Count `typeof x === "string" | "number" | "boolean" | "object"` inside current function scope
      BinaryExpression(node) {
        if (fnStack.length === 0) return;
        if (
          node.operator !== "===" &&
          node.operator !== "!==" &&
          node.operator !== "==" &&
          node.operator !== "!="
        ) {
          return;
        }

        const leftIsTypeof =
          node.left.type === "UnaryExpression" && node.left.operator === "typeof";
        const rightIsTypeof =
          node.right.type === "UnaryExpression" && node.right.operator === "typeof";

        if (!leftIsTypeof && !rightIsTypeof) return;

        const literalSide = leftIsTypeof ? node.right : node.left;
        if (
          literalSide.type === "Literal" &&
          typeof literalSide.value === "string" &&
          PRIMITIVE_TYPEOF_LITERALS.has(literalSide.value)
        ) {
          fnStack[fnStack.length - 1].typeofCount += 1;
        }
      },
    };
  },
};
