#!/usr/bin/env node
/**
 * Removes the core-js polyfill bundle that @near-wallet-selector packages vendor
 * into their published dist files (index.js / index.cjs).
 *
 * Those packages are built with @babel/preset-env `useBuiltIns: "usage"`, which
 * injects `core-js/modules/*` imports; rollup then inlines core-js into the dist
 * file instead of leaving it external. The result is ~90% of each file being a
 * full core-js 3.41 global polyfill, duplicated once per package. Because it is
 * inlined text rather than module imports, no bundler can dedupe or drop it.
 *
 * We delete exactly the statements that belong to that inlined polyfill and keep
 * every statement reachable from the module's imports/exports. The transform is
 * verified before a file is written:
 *   1. the rewritten file must still parse,
 *   2. it must export the same names,
 *   3. no kept statement may reference a name that only a deleted statement
 *      declared.
 *
 * Usage: node scripts/strip-vendored-core-js.mjs [--check]
 *   --check  report what would change and exit non-zero if anything would.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scope = path.join(root, "node_modules", "@near-wallet-selector");
const checkOnly = process.argv.includes("--check");

/** Identifiers used as a *reference*, ignoring property names and binding positions. */
function collectRefs(sf, node) {
  const refs = new Set();
  const visit = (n) => {
    if (ts.isIdentifier(n)) {
      const p = n.parent;
      const isPropName =
        (ts.isPropertyAccessExpression(p) && p.name === n) ||
        (ts.isPropertyAssignment(p) && p.name === n) ||
        (ts.isMethodDeclaration(p) && p.name === n) ||
        (ts.isPropertyDeclaration(p) && p.name === n) ||
        (ts.isVariableDeclaration(p) && p.name === n) ||
        (ts.isFunctionDeclaration(p) && p.name === n) ||
        (ts.isClassDeclaration(p) && p.name === n) ||
        (ts.isParameter(p) && p.name === n) ||
        (ts.isImportSpecifier(p) && p.name === n) ||
        (ts.isExportSpecifier(p)) ||
        (ts.isBindingElement(p) && p.name === n) ||
        (ts.isLabeledStatement(p) && p.label === n) ||
        (ts.isBreakOrContinueStatement(p) && p.label === n);
      if (!isPropName) refs.add(n.text);
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return refs;
}

/**
 * Names a top-level statement introduces (ESM bindings or CJS `exports.x =`).
 * Only top-level bindings count: locals inside function bodies must not be
 * treated as module-scope declarations.
 */
function collectDecls(_sf, node) {
  const names = new Set();
  if (ts.isVariableStatement(node)) {
    for (const d of node.declarationList.declarations) {
      if (ts.isIdentifier(d.name)) names.add(d.name.text);
    }
  } else if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) {
    names.add(node.name.text);
  } else if (
    ts.isExpressionStatement(node) &&
    ts.isBinaryExpression(node.expression) &&
    node.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    ts.isPropertyAccessExpression(node.expression.left) &&
    ts.isIdentifier(node.expression.left.expression) &&
    ["exports", "module"].includes(node.expression.left.expression.text)
  ) {
    names.add(`#export:${node.expression.left.name.text}`);
  }
  return names;
}

function isImportLike(stmt) {
  if (ts.isImportDeclaration(stmt)) return true;
  if (ts.isExportDeclaration(stmt) || ts.isExportAssignment(stmt)) return true;
  if (
    ts.isExpressionStatement(stmt) &&
    ts.isCallExpression(stmt.expression) &&
    ts.isIdentifier(stmt.expression.expression) &&
    stmt.expression.expression.text === "require"
  ) {
    return true;
  }
  if (ts.isVariableStatement(stmt)) {
    return stmt.declarationList.declarations.some(
      (d) =>
        d.initializer &&
        ts.isCallExpression(d.initializer) &&
        ts.isIdentifier(d.initializer.expression) &&
        d.initializer.expression.text === "require",
    );
  }
  return false;
}

function exportedNames(sf) {
  const out = new Set();
  for (const stmt of sf.statements) {
    if (ts.isExportDeclaration(stmt) && stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
      for (const el of stmt.exportClause.elements) out.add(el.name.text);
    } else if (ts.isExportAssignment(stmt)) {
      out.add("#default");
    } else if (ts.isExportDeclaration(stmt) && stmt.exportClause && ts.isNamespaceExport(stmt.exportClause)) {
      out.add(`*${stmt.exportClause.name.text}`);
    } else if (
      (ts.isVariableStatement(stmt) || ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt)) &&
      stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      for (const d of collectDecls(sf, stmt)) out.add(d);
    }
  }
  return out;
}

/** Parse and split a dist file into top-level statements with their spans. */
function analyse(file) {
  const source = fs.readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const stmts = sf.statements.map((node) => ({
    node,
    start: node.getFullStart(),
    text: source.slice(node.getFullStart(), node.end),
    refs: collectRefs(sf, node),
    decls: collectDecls(sf, node),
    importLike: isImportLike(node),
  }));

  const declaredBy = new Map(); // name -> statement index
  stmts.forEach((s, i) => {
    for (const d of s.decls) if (!declaredBy.has(d)) declaredBy.set(d, i);
  });

  // Seeds: import/export statements, plus anything referencing an imported binding.
  const importedBindings = new Set();
  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt) && stmt.importClause) {
      const c = stmt.importClause;
      if (c.name) importedBindings.add(c.name.text);
      if (c.namedBindings) {
        if (ts.isNamespaceImport(c.namedBindings)) importedBindings.add(c.namedBindings.name.text);
        else for (const el of c.namedBindings.elements) importedBindings.add(el.name.text);
      }
    }
  }

  const real = new Array(stmts.length).fill(false);
  stmts.forEach((s, i) => {
    if (s.importLike) real[i] = true;
    else for (const r of s.refs) if (importedBindings.has(r)) { real[i] = true; break; }
  });

  // Fixpoint: anything referencing a name declared by a kept statement is kept.
  let changed = true;
  while (changed) {
    changed = false;
    stmts.forEach((s, i) => {
      if (real[i]) return;
      for (const r of s.refs) {
        const owner = declaredBy.get(r);
        if (owner !== undefined && owner !== i && real[owner]) {
          real[i] = true;
          changed = true;
          return;
        }
      }
    });
  }

  return { file, source, sf, stmts, real, declaredBy };
}

function plan(a) {
  const kept = [];
  const dropped = [];
  for (let i = 0; i < a.stmts.length; i++) (a.real[i] ? kept : dropped).push(i);

  // Guard: a deleted statement's declared name must not be referenced by a kept one.
  const droppedDecls = new Map();
  for (const i of dropped) for (const d of a.stmts[i].decls) droppedDecls.set(d, i);
  const violations = [];
  for (const i of kept) {
    for (const r of a.stmts[i].refs) {
      if (droppedDecls.has(r) && !a.declaredBy.has(r)) violations.push({ stmt: i, name: r });
      else if (droppedDecls.has(r) && a.real[a.declaredBy.get(r)] !== true) {
        violations.push({ stmt: i, name: r });
      }
    }
  }

  const keptText = kept.map((i) => a.stmts[i].text).join("");
  const droppedText = dropped.map((i) => a.stmts[i].text).join("");
  return { kept, dropped, violations, keptText, droppedText };
}

function strip(a) {
  const { kept, dropped, violations, keptText } = plan(a);
  const parsed = ts.createSourceFile(a.file, keptText, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const parseErrors = parsed.parseDiagnostics?.length ?? 0;

  const before = [...exportedNames(a.sf)].sort();
  const after = [...exportedNames(parsed)].sort();
  const exportsMatch = before.join(",") === after.join(",");

  return {
    ok: violations.length === 0 && parseErrors === 0 && exportsMatch,
    keptText,
    droppedCount: dropped.length,
    keptCount: kept.length,
    violations,
    parseErrors,
    exportsMatch,
    beforeExports: before.length,
    afterExports: after.length,
  };
}

const targets = [];
if (fs.existsSync(scope)) {
  for (const pkg of fs.readdirSync(scope)) {
    for (const name of ["index.js", "index.cjs"]) {
      const f = path.join(scope, pkg, name);
      if (fs.existsSync(f) && fs.readFileSync(f, "utf8").includes("zloirock/core-js")) targets.push(f);
    }
  }
}

let failed = false;
let totalBefore = 0;
let totalAfter = 0;
for (const file of targets) {
  const a = analyse(file);
  const r = strip(a);
  const beforeBytes = Buffer.byteLength(a.source);
  const afterBytes = Buffer.byteLength(r.keptText);
  totalBefore += beforeBytes;
  totalAfter += afterBytes;
  const rel = path.relative(root, file);
  if (!r.ok) {
    failed = true;
    console.error(`FAIL ${rel}`);
    if (r.parseErrors) console.error(`  parse errors: ${r.parseErrors}`);
    if (!r.exportsMatch) console.error(`  exports changed: ${r.beforeExports} -> ${r.afterExports}`);
    for (const v of r.violations.slice(0, 10)) {
      console.error(`  kept statement references polyfill-only name "${v.name}"`);
    }
    continue;
  }
  console.log(
    `${checkOnly ? "would strip" : "stripped"} ${rel}: ${beforeBytes} -> ${afterBytes} bytes ` +
      `(-${(((beforeBytes - afterBytes) / beforeBytes) * 100).toFixed(1)}%), ` +
      `${r.droppedCount} polyfill statements removed, ${r.keptCount} kept`,
  );
  if (!checkOnly) fs.writeFileSync(file, r.keptText);
}

console.log(`\ntotal: ${totalBefore} -> ${totalAfter} bytes (-${totalBefore - totalAfter})`);
if (failed) process.exit(1);
if (checkOnly && totalBefore !== totalAfter) process.exit(2);
