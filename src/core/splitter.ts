import { readFile } from 'node:fs/promises';
import { basename, dirname, extname, join, relative } from 'node:path';
import ts from 'typescript';
import type { FileReport } from './analyst.js';
import type { ValidatorResult } from './validator.js';

const MAX_EXTRACTED_STATEMENTS = 14;
const MAX_EXTRACTED_LINES = 220;
const MIN_EXTRACTED_LINES = 20;

interface ExtractableStatement {
  names: string[];
  dependencies: string[];
  start: number;
  end: number;
  text: string;
  lineCount: number;
}

function isConstVariableStatement(node: ts.VariableStatement): boolean {
  return (node.declarationList.flags & ts.NodeFlags.Const) !== 0;
}

function hasExportModifier(node: ts.VariableStatement): boolean {
  return node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

function containsUnsafeSyntax(node: ts.Node): boolean {
  let unsafe = false;

  function visit(child: ts.Node): void {
    if (
      ts.isArrowFunction(child) ||
      ts.isFunctionExpression(child) ||
      ts.isClassExpression(child) ||
      ts.isNewExpression(child) ||
      ts.isCallExpression(child) ||
      ts.isJsxElement(child) ||
      ts.isJsxSelfClosingElement(child) ||
      ts.isJsxFragment(child)
    ) {
      unsafe = true;
      return;
    }

    ts.forEachChild(child, visit);
  }

  ts.forEachChild(node, visit);
  return unsafe;
}

function referencesRuntimeBoundary(text: string): boolean {
  return /\b(window|document|navigator|localStorage|sessionStorage|process|React|THREE|gsap|ScrollTrigger|Lenis)\b/.test(text);
}

function collectInitializerDependencies(initializer: ts.Expression): string[] {
  const dependencies = new Set<string>();

  function visit(node: ts.Node): void {
    if (ts.isIdentifier(node)) {
      const parent = node.parent;
      const isObjectPropertyKey =
        ts.isPropertyAssignment(parent) && parent.name === node;
      const isPropertyAccessName =
        ts.isPropertyAccessExpression(parent) && parent.name === node;

      if (!isObjectPropertyKey && !isPropertyAccessName) {
        dependencies.add(node.text);
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(initializer);
  return [...dependencies];
}

function getImportInsertPosition(sourceFile: ts.SourceFile): number {
  let insertPosition = 0;

  for (const statement of sourceFile.statements) {
    if (
      ts.isExpressionStatement(statement) &&
      ts.isStringLiteral(statement.expression)
    ) {
      insertPosition = statement.end;
      continue;
    }

    if (ts.isImportDeclaration(statement)) {
      insertPosition = statement.end;
      continue;
    }

    break;
  }

  return insertPosition === 0 ? 0 : insertPosition + 1;
}

function collectExtractableStatements(sourceFile: ts.SourceFile): ExtractableStatement[] {
  const candidates: ExtractableStatement[] = [];

  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    if (!isConstVariableStatement(statement)) continue;
    if (hasExportModifier(statement)) continue;

    const names: string[] = [];
    const dependencies = new Set<string>();
    let extractable = true;

    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) {
        extractable = false;
        break;
      }

      if (containsUnsafeSyntax(declaration.initializer)) {
        extractable = false;
        break;
      }

      const initializerText = declaration.initializer.getText(sourceFile);
      if (referencesRuntimeBoundary(initializerText)) {
        extractable = false;
        break;
      }

      for (const dependency of collectInitializerDependencies(declaration.initializer)) {
        dependencies.add(dependency);
      }

      names.push(declaration.name.text);
    }

    if (!extractable || names.length === 0) continue;

    const text = statement.getFullText(sourceFile).trim();
    const lineCount = text.split('\n').length;
    candidates.push({
      names,
      dependencies: [...dependencies].filter(dependency => !names.includes(dependency)),
      start: statement.getFullStart(),
      end: statement.end,
      text,
      lineCount,
    });
  }

  return candidates;
}

function selectExtractionSet(candidates: ExtractableStatement[]): ExtractableStatement[] {
  const selected: ExtractableStatement[] = [];
  const selectedNames = new Set<string>();
  let lineCount = 0;

  for (const candidate of candidates) {
    if (selected.length >= MAX_EXTRACTED_STATEMENTS) break;
    if (lineCount >= MAX_EXTRACTED_LINES) break;
    if (candidate.dependencies.some(dependency => !selectedNames.has(dependency))) continue;

    selected.push(candidate);
    for (const name of candidate.names) selectedNames.add(name);
    lineCount += candidate.lineCount;
  }

  return lineCount >= MIN_EXTRACTED_LINES ? selected : [];
}

function buildSplitFilePath(filePath: string): string {
  const dir = dirname(filePath);
  const ext = extname(filePath);
  const base = basename(filePath, ext);
  return join(dir, `${base}.split.ts`);
}

function buildImportSpecifier(fromFilePath: string, toFilePath: string): string {
  const fromDir = dirname(fromFilePath);
  const withoutExt = toFilePath.slice(0, -extname(toFilePath).length);
  let specifier = relative(fromDir, withoutExt).replace(/\\/g, '/');
  if (!specifier.startsWith('.')) specifier = `./${specifier}`;
  return specifier;
}

function addExport(statementText: string): string {
  return statementText.replace(/^(\s*)const\b/m, '$1export const');
}

function collectExportedConstNames(sourceFile: ts.SourceFile): Set<string> {
  const exportedNames = new Set<string>();

  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    if (!isConstVariableStatement(statement)) continue;
    if (!hasExportModifier(statement)) continue;

    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name)) {
        exportedNames.add(declaration.name.text);
      }
    }
  }

  return exportedNames;
}

function findMissingExports(sourceFile: ts.SourceFile, expectedNames: string[]): string[] {
  const exportedNames = collectExportedConstNames(sourceFile);
  return expectedNames.filter(name => !exportedNames.has(name));
}

function collectImportedNames(sourceFile: ts.SourceFile, moduleSpecifier: string): string[] {
  const importedNames: string[] = [];

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (statement.moduleSpecifier.text !== moduleSpecifier) continue;

    const namedBindings = statement.importClause?.namedBindings;
    if (!namedBindings || !ts.isNamedImports(namedBindings)) continue;

    for (const element of namedBindings.elements) {
      importedNames.push(element.name.text);
    }
  }

  return importedNames;
}

function validateSyntax(fileName: string, source: string): string | null {
  const result = ts.transpileModule(source, {
    fileName,
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      jsx: ts.JsxEmit.ReactJSX,
    },
  });

  const error = result.diagnostics?.find(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error);
  if (!error) return null;
  return ts.flattenDiagnosticMessageText(error.messageText, '\n');
}

export async function runStaticSplit(fileReport: FileReport): Promise<ValidatorResult> {
  let source: string;
  try {
    source = await readFile(fileReport.path, 'utf8');
  } catch {
    return { filePath: fileReport.path, status: 'skipped', confidenceScore: 0, skipReason: 'file unreadable' };
  }

  const sourceFile = ts.createSourceFile(fileReport.path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const selectedStatements = selectExtractionSet(collectExtractableStatements(sourceFile));

  if (selectedStatements.length === 0) {
    return {
      filePath: fileReport.path,
      status: 'skipped',
      confidenceScore: 0,
      skipReason: 'Zeno could not find static constants or data that are safe to move automatically',
    };
  }

  const splitFilePath = buildSplitFilePath(fileReport.path);
  const importSpecifier = buildImportSpecifier(fileReport.path, splitFilePath);
  const importedNames = selectedStatements.flatMap(statement => statement.names);
  const importLine = `import { ${importedNames.join(', ')} } from '${importSpecifier}';\n`;

  let updatedSource = source;
  for (const statement of [...selectedStatements].sort((a, b) => b.start - a.start)) {
    updatedSource = updatedSource.slice(0, statement.start) + updatedSource.slice(statement.end);
  }

  const importInsertPosition = getImportInsertPosition(sourceFile);
  updatedSource = updatedSource.slice(0, importInsertPosition) + importLine + updatedSource.slice(importInsertPosition);
  updatedSource = updatedSource.replace(/\n{3,}/g, '\n\n');

  const splitSource = `${selectedStatements.map(statement => addExport(statement.text)).join('\n\n')}\n`;

  const originalSyntaxError = validateSyntax(fileReport.path, updatedSource);
  if (originalSyntaxError) {
    return {
      filePath: fileReport.path,
      status: 'skipped',
      confidenceScore: 0,
      skipReason: `split did not pass syntax checks: ${originalSyntaxError}`,
    };
  }

  const splitSyntaxError = validateSyntax(splitFilePath, splitSource);
  if (splitSyntaxError) {
    return {
      filePath: fileReport.path,
      status: 'skipped',
      confidenceScore: 0,
      skipReason: `new split file did not pass syntax checks: ${splitSyntaxError}`,
    };
  }

  const updatedSourceFile = ts.createSourceFile(fileReport.path, updatedSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const splitSourceFile = ts.createSourceFile(splitFilePath, splitSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const actualImportedNames = collectImportedNames(updatedSourceFile, importSpecifier);
  const missingExports = findMissingExports(splitSourceFile, actualImportedNames);
  if (missingExports.length > 0) {
    return {
      filePath: fileReport.path,
      status: 'skipped',
      confidenceScore: 0,
      skipReason: `new split file did not export: ${missingExports.join(', ')}`,
    };
  }

  const extractedLines = selectedStatements.reduce((total, statement) => total + statement.lineCount, 0);

  return {
    filePath: fileReport.path,
    status: 'accepted',
    confidenceScore: 0.9,
    refactoredSource: updatedSource,
    createdFiles: [{ path: splitFilePath, source: splitSource }],
    linesChanged: extractedLines,
  };
}
