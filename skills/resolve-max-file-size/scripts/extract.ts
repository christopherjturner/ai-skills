import { Project, Node, Statement, ts } from "ts-morph";
import * as fs from "fs";
import * as path from "path";

interface MoveGroup {
  targetFile: string;
  declarations: string[];
}

interface ExtractPlan {
  sourceFile: string;
  moves: MoveGroup[];
}

const planPath = process.argv[2];
if (!planPath) {
  console.error("Usage: npx tsx extract.ts <plan.json>");
  process.exit(1);
}

const repoRoot = process.cwd();
const plan: ExtractPlan = JSON.parse(fs.readFileSync(planPath, "utf-8"));
const absSourcePath = path.resolve(plan.sourceFile);

// Parse ONLY the target source file upfront (avoids loading the full tsconfig program)
const project = new Project({ skipAddingFilesFromTsConfig: true });
const sourceFile = project.addSourceFileAtPath(absSourcePath);

// 1. Map which target file each declaration is moving to
const symbolTargetMap = new Map<string, string>();
for (const group of plan.moves) {
  const absTarget = path.resolve(group.targetFile);
  for (const declName of group.declarations) {
    symbolTargetMap.set(declName, absTarget);
  }
}

// 2. Single-pass index of top-level statements & declarations in sourceFile
const symbolStatements = new Map<string, Statement[]>();
const statementOwnerFile = new Map<Statement, string>();
const symbolHasValueDecl = new Set<string>();
const symbolHasTypeDecl = new Set<string>();

function registerSymbolStatement(name: string, stmt: Statement, isTypeDecl: boolean) {
  let list = symbolStatements.get(name);
  if (!list) {
    list = [];
    symbolStatements.set(name, list);
  }
  if (!list.includes(stmt)) {
    list.push(stmt);
  }
  if (isTypeDecl) {
    symbolHasTypeDecl.add(name);
  } else {
    symbolHasValueDecl.add(name);
  }
}

for (const stmt of sourceFile.getStatements()) {
  if (Node.isImportDeclaration(stmt) || Node.isExportDeclaration(stmt)) continue;

  const declaredNames: string[] = [];

  if (Node.isVariableStatement(stmt)) {
    for (const decl of stmt.getDeclarations()) {
      const nameNode = decl.getNameNode();
      if (Node.isIdentifier(nameNode)) {
        const name = nameNode.getText();
        declaredNames.push(name);
        registerSymbolStatement(name, stmt, false);
      } else {
        nameNode.forEachDescendant((node) => {
          if (Node.isIdentifier(node)) {
            const parent = node.getParent();
            if (
              Node.isBindingElement(parent) &&
              parent.getPropertyNameNode() === node &&
              parent.getNameNode() !== node
            ) {
              return;
            }
            const name = node.getText();
            declaredNames.push(name);
            registerSymbolStatement(name, stmt, false);
          }
        });
      }
    }
  } else if (
    Node.isFunctionDeclaration(stmt) ||
    Node.isClassDeclaration(stmt) ||
    Node.isEnumDeclaration(stmt)
  ) {
    const name = stmt.getName();
    if (name) {
      declaredNames.push(name);
      registerSymbolStatement(name, stmt, false);
    }
  } else if (Node.isInterfaceDeclaration(stmt) || Node.isTypeAliasDeclaration(stmt)) {
    const name = stmt.getName();
    if (name) {
      declaredNames.push(name);
      registerSymbolStatement(name, stmt, true);
    }
  }

  let owner = absSourcePath;
  for (const name of declaredNames) {
    const target = symbolTargetMap.get(name);
    if (target) {
      owner = target;
      break;
    }
  }
  statementOwnerFile.set(stmt, owner);
}

// Verify all requested declarations exist before doing work
for (const [declName] of symbolTargetMap) {
  if (!symbolStatements.has(declName)) {
    throw new Error(`Declaration '${declName}' not found in ${plan.sourceFile}`);
  }
}

const isPureTypeSymbol = (name: string) =>
  symbolHasTypeDecl.has(name) && !symbolHasValueDecl.has(name);

// 3. Fast single-pass raw compilerNode walk per statement to collect referenced identifiers
function collectReferencedIdentifiers(stmt: Statement): Set<string> {
  const refs = new Set<string>();

  function visit(node: ts.Node) {
    if (ts.isIdentifier(node)) {
      const parent = node.parent;
      if (parent) {
        // Skip right-hand side of property access (`obj.prop`) and qualified names (`NS.Type`)
        if (ts.isPropertyAccessExpression(parent) && parent.name === node) return;
        if (ts.isQualifiedName(parent) && parent.right === node) return;
        // Skip non-shorthand object/class/interface property & method keys
        if (
          (ts.isPropertyAssignment(parent) ||
            ts.isPropertyDeclaration(parent) ||
            ts.isPropertySignature(parent) ||
            ts.isMethodDeclaration(parent) ||
            ts.isMethodSignature(parent) ||
            ts.isGetAccessorDeclaration(parent) ||
            ts.isSetAccessorDeclaration(parent) ||
            ts.isEnumMember(parent) ||
            ts.isJsxAttribute(parent)) &&
          parent.name === node
        ) {
          return;
        }
        // Skip binding property alias `{ prop: local }`
        if (
          ts.isBindingElement(parent) &&
          parent.propertyName === node &&
          parent.name !== node
        ) {
          return;
        }
      }
      refs.add(node.text);
      return;
    }
    ts.forEachChild(node, visit);
  }

  ts.forEachChild(stmt.compilerNode, visit);
  return refs;
}

const needsExport = new Set<string>();
const usedIdsByFile = new Map<string, Set<string>>();
usedIdsByFile.set(absSourcePath, new Set());
for (const group of plan.moves) {
  usedIdsByFile.set(path.resolve(group.targetFile), new Set());
}

for (const [stmt, ownerFile] of statementOwnerFile.entries()) {
  const refs = collectReferencedIdentifiers(stmt);
  const fileUsedSet = usedIdsByFile.get(ownerFile)!;

  for (const idText of refs) {
    fileUsedSet.add(idText);

    if (!symbolStatements.has(idText)) continue;
    const symHomeFile = symbolTargetMap.get(idText) ?? absSourcePath;
    if (symHomeFile !== ownerFile) {
      needsExport.add(idText);
    }
  }
}

// Helper to format a statement with `export` added if required, without mutating the 1MB AST
function formatStatementText(stmt: Statement, forceExport: boolean): string {
  const fullText = stmt.getFullText();
  const triviaWidth = stmt.getLeadingTriviaWidth();
  const leadingTrivia = fullText.slice(0, triviaWidth);
  const codeText = fullText.slice(triviaWidth);

  const alreadyExported = Node.isExportable(stmt) && stmt.isExported();
  if (forceExport && Node.isExportable(stmt) && !alreadyExported) {
    return `${leadingTrivia}export ${codeText}`.trim();
  }
  return fullText.trim();
}

// Helper to compute relative module specifiers while preserving @/ aliases and packages
function toRelativeImportSpecifier(fromFile: string, toFile: string): string {
  const rel = path
    .relative(path.dirname(fromFile), toFile)
    .replace(/\\/g, "/")
    .replace(/\.(tsx?|mts|cts)$/, "")
    .replace(/\/index$/, "");
  return rel.startsWith(".") ? rel : `./${rel}`;
}

function rewriteRelativeModuleSpecifier(
  originalSpec: string,
  fromOriginalFile: string,
  toNewFile: string
): string {
  if (!originalSpec.startsWith(".")) {
    return originalSpec;
  }
  const absResolved = path.resolve(path.dirname(fromOriginalFile), originalSpec);
  const rel = path
    .relative(path.dirname(toNewFile), absResolved)
    .replace(/\\/g, "/");
  return rel.startsWith(".") ? rel : `./${rel}`;
}

// Snapshot original imports once
interface ParsedImport {
  moduleSpecifier: string;
  isTypeOnly: boolean;
  defaultImport?: string;
  namespaceImport?: string;
  namedImports: { name: string; alias?: string; isTypeOnly: boolean }[];
  isSideEffectOnly: boolean;
}

const originalImports: ParsedImport[] = sourceFile.getImportDeclarations().map((imp) => {
  const defaultImp = imp.getDefaultImport()?.getText();
  const namespaceImp = imp.getNamespaceImport()?.getText();
  const namedImps = imp.getNamedImports().map((n) => ({
    name: n.getName(),
    alias: n.getAliasNode()?.getText(),
    isTypeOnly: n.isTypeOnly(),
  }));
  return {
    moduleSpecifier: imp.getModuleSpecifierValue(),
    isTypeOnly: imp.isTypeOnly(),
    defaultImport: defaultImp,
    namespaceImport: namespaceImp,
    namedImports: namedImps,
    isSideEffectOnly: !defaultImp && !namespaceImp && namedImps.length === 0,
  };
});

function buildImportBlockForFile(targetFilePath: string, declaredInThisFile: Set<string>): string[] {
  const usedIds = usedIdsByFile.get(targetFilePath) ?? new Set<string>();
  const importLines: string[] = [];

  // 1. Pruned external imports from original sourceFile
  for (const imp of originalImports) {
    if (imp.isSideEffectOnly) {
      const rewrittenSpec = rewriteRelativeModuleSpecifier(
        imp.moduleSpecifier,
        absSourcePath,
        targetFilePath
      );
      importLines.push(`import "${rewrittenSpec}";`);
      continue;
    }

    const keepDefault = imp.defaultImport && usedIds.has(imp.defaultImport) ? imp.defaultImport : undefined;
    const keepNamespace =
      imp.namespaceImport && usedIds.has(imp.namespaceImport) ? imp.namespaceImport : undefined;
    const keepNamed = imp.namedImports.filter((n) => usedIds.has(n.alias ?? n.name));

    if (!keepDefault && !keepNamespace && keepNamed.length === 0) continue;

    const rewrittenSpec = rewriteRelativeModuleSpecifier(
      imp.moduleSpecifier,
      absSourcePath,
      targetFilePath
    );

    const clauseParts: string[] = [];
    if (keepDefault) clauseParts.push(keepDefault);
    if (keepNamespace) clauseParts.push(`* as ${keepNamespace}`);
    if (keepNamed.length > 0) {
      const specs = keepNamed.map((n) => {
        const typePrefix = !imp.isTypeOnly && n.isTypeOnly ? "type " : "";
        const aliasPart = n.alias ? ` as ${n.alias}` : "";
        return `${typePrefix}${n.name}${aliasPart}`;
      });
      clauseParts.push(`{ ${specs.join(", ")} }`);
    }

    const typeKw = imp.isTypeOnly ? "type " : "";
    importLines.push(`import ${typeKw}${clauseParts.join(", ")} from "${rewrittenSpec}";`);
  }

  // 2. Cross-file imports between split siblings and sourceFile
  const crossImportsByTarget = new Map<string, Set<string>>();
  for (const idText of usedIds) {
    if (declaredInThisFile.has(idText)) continue;
    if (!symbolStatements.has(idText)) continue;

    const symHomeFile = symbolTargetMap.get(idText) ?? absSourcePath;
    if (symHomeFile !== targetFilePath) {
      let set = crossImportsByTarget.get(symHomeFile);
      if (!set) {
        set = new Set();
        crossImportsByTarget.set(symHomeFile, set);
      }
      set.add(idText);
    }
  }

  for (const [otherFile, syms] of crossImportsByTarget.entries()) {
    const relSpec = toRelativeImportSpecifier(targetFilePath, otherFile);
    const specs = Array.from(syms).map((s) => (isPureTypeSymbol(s) ? `type ${s}` : s));
    importLines.push(`import { ${specs.join(", ")} } from "${relSpec}";`);
  }

  return importLines;
}

// 4. Write new target files directly
const movedStatementSet = new Set<Statement>();

for (const group of plan.moves) {
  const absTarget = path.resolve(group.targetFile);
  const declaredHere = new Set(group.declarations);
  const importLines = buildImportBlockForFile(absTarget, declaredHere);

  const bodyBlocks: string[] = [];
  const emittedInTarget = new Set<Statement>();

  for (const declName of group.declarations) {
    const stmts = symbolStatements.get(declName) ?? [];
    for (const stmt of stmts) {
      if (emittedInTarget.has(stmt)) continue;
      emittedInTarget.add(stmt);
      movedStatementSet.add(stmt);
      bodyBlocks.push(formatStatementText(stmt, needsExport.has(declName)));
    }
  }

  const fileParts: string[] = [];
  if (importLines.length > 0) {
    fileParts.push(importLines.join("\n"));
  }
  if (bodyBlocks.length > 0) {
    fileParts.push(bodyBlocks.join("\n\n"));
  }

  fs.mkdirSync(path.dirname(absTarget), { recursive: true });
  fs.writeFileSync(absTarget, `${fileParts.join("\n\n")}\n`, "utf-8");
}

// 5. Update or delete original sourceFile in a single write
const remainingNonImportStmts = sourceFile
  .getStatements()
  .filter((s) => !Node.isImportDeclaration(s) && !movedStatementSet.has(s));

if (remainingNonImportStmts.length === 0) {
  if (fs.existsSync(absSourcePath)) {
    fs.unlinkSync(absSourcePath);
  }
} else {
  const remainingDeclaredNames = new Set<string>();
  for (const [symName] of symbolStatements) {
    if (!symbolTargetMap.has(symName)) {
      remainingDeclaredNames.add(symName);
    }
  }

  const sourceImportLines = buildImportBlockForFile(absSourcePath, remainingDeclaredNames);
  const remainingBlocks = remainingNonImportStmts.map((stmt) => {
    let shouldExport = false;
    for (const [symName, stmts] of symbolStatements) {
      if (!symbolTargetMap.has(symName) && stmts.includes(stmt) && needsExport.has(symName)) {
        shouldExport = true;
        break;
      }
    }
    return formatStatementText(stmt, shouldExport);
  });

  const parts: string[] = [];
  if (sourceImportLines.length > 0) {
    parts.push(sourceImportLines.join("\n"));
  }
  parts.push(remainingBlocks.join("\n\n"));
  fs.writeFileSync(absSourcePath, `${parts.join("\n\n")}\n`, "utf-8");
}

// 6. Fast discovery & update of external consumer files without loading the whole repo into ts-morph
const stripExt = (p: string) =>
  p.replace(/\\/g, "/").replace(/\.(tsx?|mts|cts)$/, "").replace(/\/index$/, "");

const normalizedSourceNoExt = stripExt(absSourcePath);
const sourceBaseName = path.basename(normalizedSourceNoExt);

function resolveModuleSpecifier(spec: string, importerFile: string): string | null {
  if (spec.startsWith("@/")) {
    return stripExt(path.resolve(repoRoot, spec.slice(2)));
  }
  if (spec.startsWith(".")) {
    return stripExt(path.resolve(path.dirname(importerFile), spec));
  }
  return null;
}

function formatConsumerTargetSpecifier(
  originalSpec: string,
  importerFile: string,
  newTargetAbs: string
): string {
  if (originalSpec.startsWith("@/")) {
    const relFromRoot = path
      .relative(repoRoot, newTargetAbs)
      .replace(/\\/g, "/")
      .replace(/\.(tsx?|mts|cts)$/, "")
      .replace(/\/index$/, "");
    return `@/${relFromRoot}`;
  }
  return toRelativeImportSpecifier(importerFile, newTargetAbs);
}

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  ".next-dev",
  ".next-gate",
  ".next-load",
  ".next-preview",
  "services",
  "dist",
  "build",
  "coverage",
]);

const touchedAbsPaths = new Set<string>([
  absSourcePath,
  ...plan.moves.map((g) => path.resolve(g.targetFile)),
]);

function findCandidateConsumerFiles(dir: string, results: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      findCandidateConsumerFiles(path.join(dir, entry.name), results);
    } else if (entry.isFile() && /\.(tsx?|mts)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      const fullPath = path.join(dir, entry.name);
      if (touchedAbsPaths.has(fullPath)) continue;
      const content = fs.readFileSync(fullPath, "utf-8");
      if (content.includes(sourceBaseName)) {
        results.push(fullPath);
      }
    }
  }
  return results;
}

const candidateFiles = findCandidateConsumerFiles(repoRoot);
const consumerProject = new Project({ skipAddingFilesFromTsConfig: true });

for (const candidatePath of candidateFiles) {
  const consumerFile = consumerProject.addSourceFileAtPath(candidatePath);
  let fileModified = false;

  for (const imp of consumerFile.getImportDeclarations()) {
    const rawSpec = imp.getModuleSpecifierValue();
    if (resolveModuleSpecifier(rawSpec, candidatePath) !== normalizedSourceNoExt) continue;

    const namedImports = imp.getNamedImports();
    const redirectedByTarget = new Map<
      string,
      { name: string; alias?: string; isTypeOnly: boolean }[]
    >();

    for (const named of namedImports) {
      const symName = named.getName();
      const newTarget = symbolTargetMap.get(symName);
      if (newTarget) {
        if (!redirectedByTarget.has(newTarget)) redirectedByTarget.set(newTarget, []);
        redirectedByTarget.get(newTarget)!.push({
          name: symName,
          alias: named.getAliasNode()?.getText(),
          isTypeOnly: named.isTypeOnly() || imp.isTypeOnly(),
        });
        named.remove();
        fileModified = true;
      }
    }

    for (const [newTargetPath, specs] of redirectedByTarget.entries()) {
      const newSpec = formatConsumerTargetSpecifier(rawSpec, candidatePath, newTargetPath);
      consumerFile.addImportDeclaration({
        moduleSpecifier: newSpec,
        namedImports: specs.map((s) => ({
          name: s.name,
          alias: s.alias,
          isTypeOnly: s.isTypeOnly,
        })),
      });
    }

    if (
      imp.getNamedImports().length === 0 &&
      !imp.getDefaultImport() &&
      !imp.getNamespaceImport()
    ) {
      imp.remove();
      fileModified = true;
    }
  }

  for (const exp of consumerFile.getExportDeclarations()) {
    const rawSpec = exp.getModuleSpecifierValue();
    if (!rawSpec || resolveModuleSpecifier(rawSpec, candidatePath) !== normalizedSourceNoExt) {
      continue;
    }

    const namedExports = exp.getNamedExports();
    const redirectedByTarget = new Map<
      string,
      { name: string; alias?: string; isTypeOnly: boolean }[]
    >();

    for (const named of namedExports) {
      const symName = named.getName();
      const newTarget = symbolTargetMap.get(symName);
      if (newTarget) {
        if (!redirectedByTarget.has(newTarget)) redirectedByTarget.set(newTarget, []);
        redirectedByTarget.get(newTarget)!.push({
          name: symName,
          alias: named.getAliasNode()?.getText(),
          isTypeOnly: named.isTypeOnly() || exp.isTypeOnly(),
        });
        named.remove();
        fileModified = true;
      }
    }

    for (const [newTargetPath, specs] of redirectedByTarget.entries()) {
      const newSpec = formatConsumerTargetSpecifier(rawSpec, candidatePath, newTargetPath);
      consumerFile.addExportDeclaration({
        moduleSpecifier: newSpec,
        namedExports: specs.map((s) => ({
          name: s.name,
          alias: s.alias,
          isTypeOnly: s.isTypeOnly,
        })),
      });
    }

    if (exp.getNamedExports().length === 0 && !exp.isNamespaceExport()) {
      exp.remove();
      fileModified = true;
    }
  }

  if (fileModified) {
    consumerFile.saveSync();
  }
}

console.log("Extraction complete.");
