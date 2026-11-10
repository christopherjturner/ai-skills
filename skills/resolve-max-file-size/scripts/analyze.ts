// .agents/skills/resolve-max-file-size/scripts/analyze.ts
import { Project, Node, SyntaxKind, ts } from "ts-morph";
import * as path from "path";

const args = process.argv.slice(2);
const filePath = args.find((a) => !a.startsWith("--"));
const maxLinesIdx = args.indexOf("--max-lines");
const maxLines = maxLinesIdx !== -1 ? parseInt(args[maxLinesIdx + 1], 10) : 300;

if (!filePath) {
  console.error("Usage: npx tsx analyze.ts <file> [--max-lines <number>]");
  process.exit(1);
}

// 1. Lexer-accurate line counting (ignores comments & whitespace, preserves strings/regexes)
function countCodeLines(text: string): number {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    /* skipTrivia */ false,
    ts.LanguageVariant.Standard,
    text
  );
  const linesWithCode = new Set<number>();
  let line = 0;

  let token = scanner.scan();
  while (token !== ts.SyntaxKind.EndOfFileToken) {
    const tokenText = scanner.getTokenText();
    if (
      token !== ts.SyntaxKind.WhitespaceTrivia &&
      token !== ts.SyntaxKind.NewLineTrivia &&
      token !== ts.SyntaxKind.SingleLineCommentTrivia &&
      token !== ts.SyntaxKind.MultiLineCommentTrivia
    ) {
      // Mark every line spanned by this code token
      const tokenLines = tokenText.split(/\r?\n/).length;
      for (let i = 0; i < tokenLines; i++) {
        linesWithCode.add(line + i);
      }
    }
    line += tokenText.split(/\r?\n/).length - 1;
    token = scanner.scan();
  }

  return linesWithCode.size;
}

// 2. Parse ONLY the target file (fast, no tsconfig load required for single-file AST)
const project = new Project({ skipAddingFilesFromTsConfig: true });
const sourceFile = project.addSourceFileAtPath(path.resolve(filePath));

interface DeclEntry {
  name: string;
  kinds: Set<string>;
  isExported: boolean;
  codeLines: number;
  nodes: Node[];
  symbols: Set<any>;
  internalDeps: Set<string>;
  referencedByInternal: Set<string>;
}

const declarations = new Map<string, DeclEntry>();

function registerDecl(name: string, kind: string, isExported: boolean, stmt: Node, sym: any) {
  const existing = declarations.get(name);
  if (existing) {
    existing.kinds.add(kind);
    existing.isExported = existing.isExported || isExported;
    if (!existing.nodes.includes(stmt)) {
      existing.nodes.push(stmt);
      existing.codeLines += countCodeLines(stmt.getText());
    }
    if (sym) existing.symbols.add(sym);
  } else {
    declarations.set(name, {
      name,
      kinds: new Set([kind]),
      isExported,
      codeLines: countCodeLines(stmt.getText()),
      nodes: [stmt],
      symbols: sym ? new Set([sym]) : new Set(),
      internalDeps: new Set(),
      referencedByInternal: new Set(),
    });
  }
}

// 3. Collect top-level declarations (handles overloads, const+type merging, and destructuring)
for (const stmt of sourceFile.getStatements()) {
  if (Node.isImportDeclaration(stmt) || Node.isExportDeclaration(stmt)) continue;

  const isExported = Node.isExportable(stmt) ? stmt.isExported() : false;

  if (Node.isVariableStatement(stmt)) {
    for (const decl of stmt.getDeclarations()) {
      const nameNode = decl.getNameNode();
      // Handle both `const a = 1` and `const { a, b } = obj`
      const idNodes = Node.isIdentifier(nameNode)
        ? [nameNode]
        : nameNode.getDescendantsOfKind(SyntaxKind.Identifier);

      for (const id of idNodes) {
        registerDecl(id.getText(), "Variable", isExported, stmt, id.getSymbol());
      }
    }
  } else if (Node.isNamed(stmt) && stmt.getName()) {
    registerDecl(stmt.getName()!, stmt.getKindName(), isExported, stmt, stmt.getSymbol());
  }
}

// 4. Resolve internal dependencies using Symbol resolution (eliminates property/shadowing bugs)
const symbolToTopLevelName = new Map<any, string>();
for (const [name, entry] of declarations.entries()) {
  for (const sym of entry.symbols) {
    symbolToTopLevelName.set(sym, name);
  }
}

for (const [name, entry] of declarations.entries()) {
  for (const node of entry.nodes) {
    for (const id of node.getDescendantsOfKind(SyntaxKind.Identifier)) {
      const sym = id.getSymbol();
      const targetName = sym ? symbolToTopLevelName.get(sym) : undefined;

      // Fallback for value/type merged symbols sharing the same top-level identifier
      if (targetName && targetName !== name) {
        entry.internalDeps.add(targetName);
        declarations.get(targetName)?.referencedByInternal.add(name);
      } else if (!sym) {
        // When skipAddingFilesFromTsConfig is true, local symbols still resolve,
        // but guard against property access (`obj.foo`) and property assignment (`{ foo: 1 }`)
        const parent = id.getParent();
        const isPropAccess =
          Node.isPropertyAccessExpression(parent) && parent.getNameNode() === id;
        const isPropAssign =
          Node.isPropertyAssignment(parent) && parent.getNameNode() === id;

        const idText = id.getText();
        if (!isPropAccess && !isPropAssign && idText !== name && declarations.has(idText)) {
          entry.internalDeps.add(idText);
          declarations.get(idText)?.referencedByInternal.add(name);
        }
      }
    }
  }
}

// 5. Build output report
const allDecls = Array.from(declarations.values()).map((d) => ({
  name: d.name,
  kind: Array.from(d.kinds).join("+"),
  isExported: d.isExported,
  codeLines: d.codeLines,
  internalDeps: Array.from(d.internalDeps),
  referencedByInternal: Array.from(d.referencedByInternal),
}));

const oversized = allDecls.filter((d) => d.codeLines > maxLines);

console.log(
  JSON.stringify(
    {
      file: filePath,
      totalCodeLines: countCodeLines(sourceFile.getFullText()),
      maxLinesLimit: maxLines,
      abort: oversized.length > 0,
      abortReason:
        oversized.length > 0
          ? `Single declaration(s) exceed max line limit of ${maxLines}: ${oversized
              .map((o) => `${o.name} (${o.codeLines} lines)`)
              .join(", ")}`
          : null,
      declarations: allDecls,
    },
    null,
    2
  )
);
