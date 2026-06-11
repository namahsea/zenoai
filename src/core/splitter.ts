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

      names.push(declaration.name.text);
    }

    if (!extractable || names.length === 0) continue;

    const text = statement.getFullText(sourceFile).trim();
    const lineCount = text.split('\n').length;
    candidates.push({
      names,
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
  let lineCount = 0;

  for (const candidate of candidates) {
    if (selected.length >= MAX_EXTRACTED_STATEMENTS) break;
    if (lineCount >= MAX_EXTRACTED_LINES) break;

    selected.push(candidate);
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
  return statementText.replace(/^(\s*)const\b/, '$1export const');
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
      skipReason: 'no safe top-level static constants or data blocks found to split automatically',
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
      skipReason: `split output failed syntax validation: ${originalSyntaxError}`,
    };
  }

  const splitSyntaxError = validateSyntax(splitFilePath, splitSource);
  if (splitSyntaxError) {
    return {
      filePath: fileReport.path,
      status: 'skipped',
      confidenceScore: 0,
      skipReason: `created split module failed syntax validation: ${splitSyntaxError}`,
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
