import {
  type ArrowFunction,
  type ClassDeclaration,
  type EnumDeclaration,
  type FunctionDeclaration,
  type FunctionExpression,
  type InterfaceDeclaration,
  type JSDocableNode,
  type MethodDeclaration,
  type ModifierableNode,
  Node,
  type ParameteredNode,
  Project,
  type ReturnTypedNode,
  type SourceFile,
  type TypeAliasDeclaration,
  type TypeParameteredNode,
  type VariableDeclaration,
  type VariableStatement,
  ts,
} from 'ts-morph';
import type { Candidate, Chunk, ChunkError, ChunkKind, ChunkerOutput, Result } from '../../shared/types.js';
import { estimateTokens } from '../tokens.js';
import type { Chunker } from './index.js';

const MAX_TOKENS = 512;

const TS_JS_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs']);

const project = new Project({
  useInMemoryFileSystem: true,
  skipLoadingLibFiles: true,
  compilerOptions: {
    allowJs: true,
    jsx: ts.JsxEmit.ReactJSX,
    target: ts.ScriptTarget.ES2022,
  },
});

function modifiersPrefix(node: ModifierableNode): string {
  const modifiers = node.getModifiers();
  return modifiers.length > 0 ? `${modifiers.map((m) => m.getText()).join(' ')} ` : '';
}

function typeParamsSuffix(node: TypeParameteredNode): string {
  const typeParams = node.getTypeParameters();
  return typeParams.length > 0 ? `<${typeParams.map((tp) => tp.getText()).join(', ')}>` : '';
}

function paramsGroup(node: ParameteredNode): string {
  return `(${node.getParameters().map((p) => p.getText()).join(', ')})`;
}

function returnTypeSuffix(node: ReturnTypedNode): string {
  const returnType = node.getReturnTypeNode();
  return returnType ? `: ${returnType.getText()}` : '';
}

function jsDocText(node: JSDocableNode): string | null {
  const docs = node.getJsDocs();
  return docs.length > 0 ? docs.map((d) => d.getText()).join('\n') : null;
}

interface BuiltChunkInput {
  candidate: Candidate;
  symbolName: string | null;
  kind: ChunkKind;
  signature: string | null;
  jsDoc: string | null;
  startLine: number;
  endLine: number;
  parentSymbol: string | null;
  isExported: boolean;
  content: string;
  chunkerKind?: string;
  partIndex?: number;
  partTotal?: number;
}

function buildChunk(input: BuiltChunkInput): Chunk {
  return {
    filePath: input.candidate.filePath,
    symbolName: input.symbolName,
    kind: input.kind,
    signature: input.signature,
    jsDoc: input.jsDoc,
    startLine: input.startLine,
    endLine: input.endLine,
    parentSymbol: input.parentSymbol,
    isExported: input.isExported,
    contentHash: '',
    language: input.candidate.language,
    chunkerKind: input.chunkerKind ?? 'ts-morph',
    partIndex: input.partIndex ?? 1,
    partTotal: input.partTotal ?? 1,
    content: input.content,
    embedText: '',
  };
}

function classSignature(classDecl: ClassDeclaration): string {
  const name = classDecl.getName() ?? '';
  const extendsClause = classDecl.getExtends();
  const implementsClauses = classDecl.getImplements();
  const extendsText = extendsClause ? ` extends ${extendsClause.getText()}` : '';
  const implementsText =
    implementsClauses.length > 0 ? ` implements ${implementsClauses.map((i) => i.getText()).join(', ')}` : '';
  return `${modifiersPrefix(classDecl)}class ${name}${typeParamsSuffix(classDecl)}${extendsText}${implementsText}`;
}

function methodSignature(method: MethodDeclaration): string {
  const generator = method.isGenerator() ? '*' : '';
  const optional = method.hasQuestionToken() ? '?' : '';
  return `${modifiersPrefix(method)}${generator}${method.getName()}${optional}${typeParamsSuffix(method)}${paramsGroup(method)}${returnTypeSuffix(method)}`;
}

function classChunks(candidate: Candidate, classDecl: ClassDeclaration): Chunk[] {
  const name = classDecl.getName() ?? null;
  const startLine = classDecl.getStartLineNumber(true);
  const endLine = classDecl.getEndLineNumber();
  const content = classDecl.getText();
  const isExported = classDecl.isExported();

  if (estimateTokens(content) <= MAX_TOKENS) {
    return [
      buildChunk({
        candidate,
        symbolName: name,
        kind: 'class',
        signature: classSignature(classDecl),
        jsDoc: jsDocText(classDecl),
        startLine,
        endLine,
        parentSymbol: null,
        isExported,
        content,
      }),
    ];
  }

  const methods = classDecl.getMethods();
  const partTotal = methods.length;
  return methods.map((method, index) =>
    buildChunk({
      candidate,
      symbolName: method.getName(),
      kind: 'method',
      signature: methodSignature(method),
      jsDoc: jsDocText(method),
      startLine: method.getStartLineNumber(true),
      endLine: method.getEndLineNumber(),
      parentSymbol: name,
      isExported,
      content: method.getText(),
      partIndex: index + 1,
      partTotal,
    }),
  );
}

function functionSignature(fn: FunctionDeclaration): string {
  const generator = fn.isGenerator() ? '*' : '';
  const name = fn.getName() ?? '';
  return `${modifiersPrefix(fn)}function${generator} ${name}${typeParamsSuffix(fn)}${paramsGroup(fn)}${returnTypeSuffix(fn)}`;
}

function functionChunk(candidate: Candidate, fn: FunctionDeclaration): Chunk {
  return buildChunk({
    candidate,
    symbolName: fn.getName() ?? null,
    kind: 'function',
    signature: functionSignature(fn),
    jsDoc: jsDocText(fn),
    startLine: fn.getStartLineNumber(true),
    endLine: fn.getEndLineNumber(),
    parentSymbol: null,
    isExported: fn.isExported(),
    content: fn.getText(),
  });
}

function interfaceSignature(iface: InterfaceDeclaration): string {
  const extendsClauses = iface.getExtends();
  const extendsText = extendsClauses.length > 0 ? ` extends ${extendsClauses.map((e) => e.getText()).join(', ')}` : '';
  return `${modifiersPrefix(iface)}interface ${iface.getName()}${typeParamsSuffix(iface)}${extendsText}`;
}

function interfaceChunk(candidate: Candidate, iface: InterfaceDeclaration): Chunk {
  return buildChunk({
    candidate,
    symbolName: iface.getName(),
    kind: 'interface',
    signature: interfaceSignature(iface),
    jsDoc: jsDocText(iface),
    startLine: iface.getStartLineNumber(true),
    endLine: iface.getEndLineNumber(),
    parentSymbol: null,
    isExported: iface.isExported(),
    content: iface.getText(),
  });
}

function typeAliasSignature(alias: TypeAliasDeclaration): string {
  const typeNode = alias.getTypeNode();
  const typeText = typeNode ? typeNode.getText() : '';
  return `${modifiersPrefix(alias)}type ${alias.getName()}${typeParamsSuffix(alias)} = ${typeText}`;
}

function typeAliasChunk(candidate: Candidate, alias: TypeAliasDeclaration): Chunk {
  return buildChunk({
    candidate,
    symbolName: alias.getName(),
    kind: 'type-alias',
    signature: typeAliasSignature(alias),
    jsDoc: jsDocText(alias),
    startLine: alias.getStartLineNumber(true),
    endLine: alias.getEndLineNumber(),
    parentSymbol: null,
    isExported: alias.isExported(),
    content: alias.getText(),
  });
}

function enumSignature(enumDecl: EnumDeclaration): string {
  const members = enumDecl
    .getMembers()
    .map((m) => m.getName())
    .join(', ');
  return `${modifiersPrefix(enumDecl)}enum ${enumDecl.getName()} { ${members} }`;
}

function enumChunk(candidate: Candidate, enumDecl: EnumDeclaration): Chunk {
  return buildChunk({
    candidate,
    symbolName: enumDecl.getName(),
    kind: 'enum',
    signature: enumSignature(enumDecl),
    jsDoc: jsDocText(enumDecl),
    startLine: enumDecl.getStartLineNumber(true),
    endLine: enumDecl.getEndLineNumber(),
    parentSymbol: null,
    isExported: enumDecl.isExported(),
    content: enumDecl.getText(),
  });
}

function isCallableInitializer(node: Node | undefined): node is ArrowFunction | FunctionExpression {
  return Node.isArrowFunction(node) || Node.isFunctionExpression(node);
}

function constSignature(decl: VariableDeclaration): string {
  const name = decl.getName();
  const init = decl.getInitializer();

  if (Node.isArrowFunction(init)) {
    const asyncPrefix = init.isAsync() ? 'async ' : '';
    return `const ${name} = ${asyncPrefix}${paramsGroup(init)}${returnTypeSuffix(init)} => …`;
  }

  if (Node.isFunctionExpression(init)) {
    const asyncPrefix = init.isAsync() ? 'async ' : '';
    const generator = init.isGenerator() ? '*' : '';
    return `const ${name} = ${asyncPrefix}function${generator}${paramsGroup(init)}${returnTypeSuffix(init)} { … }`;
  }

  const typeNode = decl.getTypeNode();
  return typeNode ? `const ${name}: ${typeNode.getText()}` : `const ${name}`;
}

function qualifyingDeclarator(
  statement: VariableStatement,
  isExportedStatement: boolean,
): VariableDeclaration | undefined {
  return statement
    .getDeclarationList()
    .getDeclarations()
    .find((decl) => isExportedStatement || isCallableInitializer(decl.getInitializer()));
}

function constChunk(candidate: Candidate, statement: VariableStatement): Chunk | null {
  const isExportedStatement = statement.isExported();
  const qualifying = qualifyingDeclarator(statement, isExportedStatement);
  if (!qualifying) {
    return null;
  }

  return buildChunk({
    candidate,
    symbolName: qualifying.getName(),
    kind: 'const',
    signature: constSignature(qualifying),
    jsDoc: jsDocText(statement),
    startLine: statement.getStartLineNumber(true),
    endLine: statement.getEndLineNumber(),
    parentSymbol: null,
    isExported: isExportedStatement,
    content: statement.getText(),
  });
}

function reExportChunk(candidate: Candidate, sourceFile: SourceFile): Chunk {
  const content = sourceFile.getFullText();
  const lastLine = sourceFile.getEndLineNumber();
  return buildChunk({
    candidate,
    symbolName: null,
    kind: 're-export',
    signature: null,
    jsDoc: null,
    startLine: 1,
    endLine: lastLine,
    parentSymbol: null,
    isExported: true,
    content,
  });
}

function wholeFileChunk(candidate: Candidate, sourceFile: SourceFile): Chunk {
  const content = sourceFile.getFullText();
  const lastLine = sourceFile.getEndLineNumber();
  return buildChunk({
    candidate,
    symbolName: null,
    kind: 'file',
    signature: null,
    jsDoc: null,
    startLine: 1,
    endLine: lastLine,
    parentSymbol: null,
    isExported: false,
    content,
  });
}

function collectChunks(candidate: Candidate, sourceFile: SourceFile): Chunk[] {
  const chunks: Chunk[] = [];
  let hasReExport = false;

  for (const statement of sourceFile.getStatements()) {
    if (Node.isClassDeclaration(statement)) {
      chunks.push(...classChunks(candidate, statement));
    } else if (Node.isFunctionDeclaration(statement)) {
      chunks.push(functionChunk(candidate, statement));
    } else if (Node.isInterfaceDeclaration(statement)) {
      chunks.push(interfaceChunk(candidate, statement));
    } else if (Node.isTypeAliasDeclaration(statement)) {
      chunks.push(typeAliasChunk(candidate, statement));
    } else if (Node.isEnumDeclaration(statement)) {
      chunks.push(enumChunk(candidate, statement));
    } else if (Node.isVariableStatement(statement)) {
      const chunk = constChunk(candidate, statement);
      if (chunk) chunks.push(chunk);
    } else if (Node.isExportDeclaration(statement) && statement.getModuleSpecifierValue() !== undefined) {
      hasReExport = true;
    }
  }

  if (chunks.length === 0 && hasReExport) {
    return [reExportChunk(candidate, sourceFile)];
  }

  return chunks;
}

function fallbackWindowChunks(candidate: Candidate, source: string): Chunk[] {
  const lines = source.split('\n');
  const windows: Array<{ startLine: number; endLine: number; content: string }> = [];
  let windowLines: string[] = [];
  let windowStart = 1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const candidateLines = [...windowLines, line];
    if (windowLines.length > 0 && estimateTokens(candidateLines.join('\n')) > MAX_TOKENS) {
      windows.push({ startLine: windowStart, endLine: windowStart + windowLines.length - 1, content: windowLines.join('\n') });
      windowStart += windowLines.length;
      windowLines = [line];
    } else {
      windowLines = candidateLines;
    }
  }
  if (windowLines.length > 0) {
    windows.push({ startLine: windowStart, endLine: windowStart + windowLines.length - 1, content: windowLines.join('\n') });
  }

  const partTotal = windows.length;
  return windows.map((w, index) =>
    buildChunk({
      candidate,
      symbolName: null,
      kind: 'window',
      signature: null,
      jsDoc: null,
      startLine: w.startLine,
      endLine: w.endLine,
      parentSymbol: null,
      isExported: false,
      content: w.content,
      chunkerKind: 'fallback',
      partIndex: index + 1,
      partTotal,
    }),
  );
}

function chunkSource(candidate: Candidate, source: string): Result<ChunkerOutput, ChunkError> {
  try {
    const sourceFile = project.createSourceFile(candidate.filePath, source, { overwrite: true });
    try {
      const diagnostics = project.getProgram().getSyntacticDiagnostics(sourceFile);
      if (diagnostics.length > 0) {
        return { ok: true, value: { chunks: fallbackWindowChunks(candidate, source), outcome: 'degraded' } };
      }

      const chunks = collectChunks(candidate, sourceFile);
      if (chunks.length === 0) {
        return { ok: true, value: { chunks: [wholeFileChunk(candidate, sourceFile)], outcome: 'no-declarations' } };
      }
      return { ok: true, value: { chunks, outcome: 'chunked' } };
    } finally {
      project.removeSourceFile(sourceFile);
    }
  } catch (error) {
    return { ok: false, error: { filePath: candidate.filePath, reason: error instanceof Error ? error.message : String(error) } };
  }
}

export const tsMorphChunker: Chunker = {
  name: 'ts-morph',
  chunkerKind: 'ts-morph',
  supports(candidate) {
    return TS_JS_EXTENSIONS.has(candidate.extension);
  },
  chunk(candidate, source) {
    return chunkSource(candidate, source);
  },
};
