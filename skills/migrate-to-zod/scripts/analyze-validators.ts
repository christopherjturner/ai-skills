import { Project, Node, SyntaxKind, FunctionDeclaration, ArrowFunction, FunctionExpression } from "ts-morph";
import * as path from "path";
import * as fs from "fs";

const args = process.argv.slice(2);
const catIdx = args.indexOf("--category");
const limitIdx = args.indexOf("--limit");
const flagValueIndices = new Set<number>();
if (catIdx !== -1) flagValueIndices.add(catIdx + 1);
if (limitIdx !== -1) flagValueIndices.add(limitIdx + 1);

const targetArgs = args.filter((a, i) => !a.startsWith("--") && !flagValueIndices.has(i));
const targets = targetArgs.length > 0 ? targetArgs : ["lib", "app"];
const jsonMode = args.includes("--json");
const categoryFilter = catIdx !== -1 ? args[catIdx + 1] : undefined;
const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : 40;

const NAME_PATTERNS = /^(parse|tryParse|safeParse|validate|isValid|assertValid|ensureValid|coerce|normalize|sanitize|toDate|toIso|isDate|isUuid|isEmail|readString|readNumber|readBoolean|readDate|readArray|asString|asNumber|asRecord)/i;
const DATE_NAME_PATTERNS = /(date|time|timestamp|iso|day|month|year|deadline|period|window)/i;

function collectTsFiles(dirOrFile: string): string[] {
  const resolved = path.resolve(dirOrFile);
  if (!fs.existsSync(resolved)) return [];
  const stat = fs.statSync(resolved);
  if (stat.isFile()) return [resolved];

  const results: string[] = [];
  for (const entry of fs.readdirSync(resolved, { withFileTypes: true })) {
    const full = path.join(resolved, entry.name);
    if (entry.isDirectory()) {
      if (["node_modules", ".next", "dist", "coverage", "__tests__"].includes(entry.name)) continue;
      results.push(...collectTsFiles(full));
    } else if (
      entry.isFile() &&
      (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".test.tsx") &&
      !entry.name.endsWith(".spec.ts") &&
      !entry.name.endsWith(".d.ts")
    ) {
      results.push(full);
    }
  }
  return results;
}

type FnNode = FunctionDeclaration | ArrowFunction | FunctionExpression;

interface ValidatorCandidate {
  file: string;
  line: number;
  name: string;
  isExported: boolean;
  category: "date" | "Input/Shape" | "Primitive/Coercion" | "Format/Regex";
  score: number;
  params: string[];
  returnType: string;
  failureMode: ("throws" | "returns-null" | "returns-boolean" | "returns-result" | "fallback")[];
  signals: string[];
  coercions: string[];
  linesOfCode: number;
}

function getFunctionInfo(node: FnNode): { name: string; isExported: boolean } | null {
  if (Node.isFunctionDeclaration(node)) {
    const name = node.getName();
    if (!name) return null;
    return { name, isExported: node.isExported() };
  }
  const parent = node.getParent();
  if (Node.isVariableDeclaration(parent)) {
    const name = parent.getName();
    const varStmt = parent.getFirstAncestorByKind(SyntaxKind.VariableStatement);
    const isExported = varStmt ? varStmt.isExported() : false;
    return { name, isExported };
  }
  return null;
}

function analyzeFunction(node: FnNode, relFile: string): ValidatorCandidate | null {
  const info = getFunctionInfo(node);
  if (!info) return null;
  const { name, isExported } = info;

  // Skip React components (PascalCase)
  if (/^[A-Z]/.test(name)) return null;

  const body = node.getBody();
  if (!body) return null;
  const bodyText = body.getText();
  const lineCount = bodyText.split(/\r?\n/).length;
  if (lineCount < 2 || lineCount > 180) return null;

  const signals: string[] = [];
  const coercions: string[] = [];
  let score = 0;

  const nameMatches = NAME_PATTERNS.test(name);
  const dateNameMatches = DATE_NAME_PATTERNS.test(name);

  if (nameMatches) {
    score += 3;
    signals.push(`name:${name}`);
  }

  // Parameter signals
  const params = node.getParameters().map((p) => p.getText());
  const paramsText = params.join(", ");
  if (/\b(unknown|any|FormData|URLSearchParams)\b/.test(paramsText)) {
    score += 3;
    signals.push("accepts-unknown/raw");
  } else if (/Record<string,\s*unknown>/.test(paramsText)) {
    score += 3;
    signals.push("accepts-record-unknown");
  }

  // Date signals
  const hasNewDate = /\bnew\s+Date\s*\([^)]+\)/.test(bodyText);
  const hasDateParse = /\bDate\.parse\s*\(/.test(bodyText) || /\bDate\.UTC\s*\(/.test(bodyText);
  const hasIsoDateRegex = /\\d\{4\}-\\d\{2\}-\\d\{2\}/.test(bodyText) || /\d{4}-\d{2}-\d{2}/.test(bodyText);
  const hasInvalidDateCheck =
    /Number\.isNaN\s*\([^)]*\.getTime\s*\(\)/.test(bodyText) ||
    /isNaN\s*\([^)]*\.getTime\s*\(\)/.test(bodyText) ||
    /isNaN\s*\(\s*Date\.parse/.test(bodyText) ||
    /\bisValid\s*\(/.test(bodyText);

  if (hasNewDate) {
    score += 2;
    signals.push("new Date(arg)");
  }
  if (hasDateParse) {
    score += 3;
    signals.push("Date.parse/UTC");
  }
  if (hasIsoDateRegex) {
    score += 4;
    signals.push("YYYY-MM-DD-regex");
  }
  if (hasInvalidDateCheck) {
    score += 4;
    signals.push("NaN-date-check");
  }

  // Type / Shape guard signals
  const typeofCount = (bodyText.match(/\btypeof\s+[a-zA-Z0-9_$.]+\s*[!=]==?\s*["'](string|number|boolean|object)["']/g) || []).length;
  if (typeofCount > 0) {
    score += Math.min(typeofCount * 2, 6);
    signals.push(`typeof-guards(${typeofCount})`);
  }

  if (/\bArray\.isArray\s*\(/.test(bodyText)) {
    score += 2;
    signals.push("Array.isArray");
  }

  // Regex / Number parsing signals
  const hasRegexTest = /\.test\s*\(/.test(bodyText) || /\.match\s*\(/.test(bodyText);
  if (hasRegexTest) {
    score += 2;
    signals.push("regex-check");
  }

  const hasNumberParse = /\b(Number\.isFinite|Number\.isInteger|Number\.parseInt|Number\.parseFloat|parseInt|parseFloat)\s*\(/.test(bodyText);
  if (hasNumberParse && (nameMatches || typeofCount > 0)) {
    score += 2;
    signals.push("number-parse/check");
  }

  // Coercion detection
  if (/\.trim\s*\(\s*\)/.test(bodyText)) coercions.push("trim()");
  if (/\.toLowerCase\s*\(\s*\)|\.toUpperCase\s*\(\s*\)/.test(bodyText)) coercions.push("case-norm");
  if (/===\s*["']["']\s*\?\s*null|!\s*[a-zA-Z0-9_]+\.trim\(\)\s*\)\s*return\s+null/.test(bodyText)) {
    coercions.push("empty->null");
  }

  const hasValidationBody =
    hasInvalidDateCheck || hasIsoDateRegex || hasDateParse || typeofCount >= 1 || (hasRegexTest && nameMatches) || (hasNewDate && dateNameMatches && nameMatches);

  if (!hasValidationBody || score < 5) return null;

  // Determine Failure Mode
  const failureMode: ValidatorCandidate["failureMode"] = [];
  if (/\bthrow\s+new\b/.test(bodyText)) failureMode.push("throws");
  if (/\breturn\s+null\b|\breturn\s+undefined\b/.test(bodyText)) failureMode.push("returns-null");
  const returnTypeNode = node.getReturnTypeNode();
  const returnType = returnTypeNode ? returnTypeNode.getText() : "inferred";
  if (/\bis\s+[A-Z]/.test(returnType) || returnType === "boolean" || /^is[A-Z]/.test(name)) {
    failureMode.push("returns-boolean");
  }
  if (/\{\s*(ok|valid|success|errors|error)\s*:/.test(bodyText)) {
    failureMode.push("returns-result");
  }
  if (failureMode.length === 0) failureMode.push("fallback");

  // Categorize
  let category: ValidatorCandidate["category"] = "Primitive/Coercion";
  if (hasIsoDateRegex || hasInvalidDateCheck || hasDateParse || (hasNewDate && dateNameMatches)) {
    category = "date";
  } else if (typeofCount >= 2 || /Record<string,\s*unknown>/.test(paramsText)) {
    category = "Input/Shape";
  } else if (hasRegexTest) {
    category = "Format/Regex";
  }

  return {
    file: relFile,
    line: node.getStartLineNumber(),
    name,
    isExported,
    category,
    score,
    params,
    returnType,
    failureMode,
    signals,
    coercions,
    linesOfCode: lineCount,
  };
}

const files = targets.flatMap((t) => collectTsFiles(t));
const targetLabel = targets.join(", ");
const project = new Project({ skipAddingFilesFromTsConfig: true });
const candidates: ValidatorCandidate[] = [];

for (const file of files) {
  const sf = project.addSourceFileAtPath(file);
  const relFile = path.relative(process.cwd(), file);

  sf.forEachDescendant((node) => {
    if (
      Node.isFunctionDeclaration(node) ||
      Node.isArrowFunction(node) ||
      Node.isFunctionExpression(node)
    ) {
      const candidate = analyzeFunction(node, relFile);
      if (candidate) {
        if (!categoryFilter || candidate.category.toLowerCase() === categoryFilter.toLowerCase()) {
          candidates.push(candidate);
        }
      }
    }
  });
  project.removeSourceFile(sf);
}

candidates.sort((a, b) => b.score - a.score || b.linesOfCode - a.linesOfCode);

const byCategory = candidates.reduce<Record<string, number>>((acc, c) => {
  acc[c.category] = (acc[c.category] || 0) + 1;
  return acc;
}, {});

const byNameStem = candidates.reduce<Record<string, number>>((acc, c) => {
  acc[c.name] = (acc[c.name] || 0) + 1;
  return acc;
}, {});

const duplicateNames = Object.entries(byNameStem)
  .filter(([, count]) => count > 1)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 20);

if (jsonMode) {
  console.log(
    JSON.stringify(
      {
        scannedFiles: files.length,
        totalCandidates: candidates.length,
        byCategory,
        duplicateFunctionNames: duplicateNames,
        topCandidates: candidates.slice(0, limit),
      },
      null,
      2
    )
  );
} else {
  console.log(`Scanned ${files.length} files in '${targetLabel}'`);
  console.log(`Found ${candidates.length} hand-rolled validator/parser candidates:\n`);
  console.log("By Category:", byCategory);
  console.log("\nMost Duplicated Validator Function Names Across Files:");
  for (const [fnName, count] of duplicateNames) {
    console.log(`  - ${fnName}: ${count} definitions`);
  }
  console.log(`\nTop ${Math.min(limit, candidates.length)} Candidates:`);
  for (const c of candidates.slice(0, limit)) {
    console.log(
      `  [${c.category}] ${c.file}:${c.line} -> ${c.name}(${c.params.join(", ")}) : ${c.returnType}`
    );
    console.log(
      `      score=${c.score} loc=${c.linesOfCode} mode=[${c.failureMode.join(",")}] signals=[${c.signals.join(", ")}] coercions=[${c.coercions.join(", ")}]`
    );
  }
}
