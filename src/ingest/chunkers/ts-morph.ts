import {
  type ArrowFunction,
  type ClassDeclaration,
  type ConstructorDeclaration,
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
  type Statement,
  type TypeAliasDeclaration,
  type TypeNode,
  type TypeParameteredNode,
  type VariableDeclaration,
  type VariableStatement,
  ts,
} from 'ts-morph';
import type { Candidate, Chunk, ChunkError, ChunkKind, ChunkerOutput, Result } from '../../shared/types.js';
import { type LineWindow, splitByLines, tagParts } from '../enrich.js';
import { estimateTokens } from '../../tokens.js';
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

type ChunkBase = Omit<BuiltChunkInput, 'startLine' | 'endLine' | 'content' | 'partIndex' | 'partTotal'>;

function maybeSplit(base: ChunkBase, startLine: number, endLine: number, content: string): Chunk[] {
  if (estimateTokens(content) <= MAX_TOKENS) {
    return [buildChunk({ ...base, startLine, endLine, content })];
  }

  const windows = tagParts(splitByLines(content, startLine, MAX_TOKENS));
  return windows.map((w) =>
    buildChunk({
      ...base,
      startLine: w.startLine,
      endLine: w.endLine,
      content: w.content,
      partIndex: w.partIndex,
      partTotal: w.partTotal,
    }),
  );
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

function constructorSignature(ctor: ConstructorDeclaration): string {
  return `${modifiersPrefix(ctor)}constructor${paramsGroup(ctor)}`;
}

function classChunks(candidate: Candidate, classDecl: ClassDeclaration): Chunk[] {
  const name = classDecl.getName() ?? null;
  const startLine = classDecl.getStartLineNumber();
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

  const sourceLines = classDecl.getSourceFile().getFullText().split('\n');
  const methods = classDecl.getMethods();
  const constructorDecl = classDecl.getConstructors()[0];

  // Header content stops before the constructor/first method's own leading trivia (JSDoc
  // included), so the header and the members that follow never overlap in source lines.
  const boundaryStarts = [
    ...(constructorDecl ? [constructorDecl.getStartLineNumber(true)] : []),
    ...methods.map((m) => m.getStartLineNumber(true)),
  ];
  const headerEndLine = boundaryStarts.length > 0 ? Math.min(...boundaryStarts) - 1 : endLine;
  const headerContent = sourceLines.slice(startLine - 1, headerEndLine).join('\n');

  const partTotal = 1 + (constructorDecl ? 1 : 0) + methods.length;
  let partIndex = 1;

  const chunks: Chunk[] = [
    buildChunk({
      candidate,
      symbolName: name,
      kind: 'class',
      signature: classSignature(classDecl),
      jsDoc: jsDocText(classDecl),
      startLine,
      endLine: headerEndLine,
      parentSymbol: null,
      isExported,
      content: headerContent,
      partIndex: partIndex++,
      partTotal,
    }),
  ];

  if (constructorDecl) {
    chunks.push(
      buildChunk({
        candidate,
        symbolName: 'constructor',
        kind: 'method',
        signature: constructorSignature(constructorDecl),
        jsDoc: jsDocText(constructorDecl),
        startLine: constructorDecl.getStartLineNumber(),
        endLine: constructorDecl.getEndLineNumber(),
        parentSymbol: name,
        isExported,
        content: constructorDecl.getText(),
        partIndex: partIndex++,
        partTotal,
      }),
    );
  }

  for (const method of methods) {
    chunks.push(
      buildChunk({
        candidate,
        symbolName: method.getName(),
        kind: 'method',
        signature: methodSignature(method),
        jsDoc: jsDocText(method),
        startLine: method.getStartLineNumber(),
        endLine: method.getEndLineNumber(),
        parentSymbol: name,
        isExported,
        content: method.getText(),
        partIndex: partIndex++,
        partTotal,
      }),
    );
  }

  return chunks;
}

function functionSignature(fn: FunctionDeclaration): string {
  const generator = fn.isGenerator() ? '*' : '';
  const name = fn.getName() ?? '';
  return `${modifiersPrefix(fn)}function${generator} ${name}${typeParamsSuffix(fn)}${paramsGroup(fn)}${returnTypeSuffix(fn)}`;
}

interface StatementGroup {
  statements: readonly Statement[];
  startLine: number;
}

function groupStatementsByBudget(sourceLines: string[], statements: readonly Statement[]): StatementGroup[] {
  const groups: StatementGroup[] = [];
  let current: Statement[] = [];
  let groupStartLine = 0;

  for (const statement of statements) {
    if (current.length > 0) {
      const candidateContent = sourceLines.slice(groupStartLine - 1, statement.getEndLineNumber()).join('\n');
      if (estimateTokens(candidateContent) > MAX_TOKENS) {
        groups.push({ statements: current, startLine: groupStartLine });
        current = [];
      }
    }
    if (current.length === 0) groupStartLine = statement.getStartLineNumber();
    current.push(statement);
  }
  if (current.length > 0) groups.push({ statements: current, startLine: groupStartLine });

  return groups;
}

function packStatementsByBudget(sourceLines: string[], statements: readonly Statement[]): LineWindow[] {
  const groups = groupStatementsByBudget(sourceLines, statements);
  const bodyEndLine = statements[statements.length - 1]?.getEndLineNumber() ?? 0;

  return groups.map((group, index) => {
    const startLine = group.startLine;
    const nextGroup = groups[index + 1];
    const endLine = nextGroup ? nextGroup.startLine - 1 : bodyEndLine;
    return { startLine, endLine, content: sourceLines.slice(startLine - 1, endLine).join('\n') };
  });
}

function functionChunks(candidate: Candidate, fn: FunctionDeclaration): Chunk[] {
  const name = fn.getName() ?? null;
  const signature = functionSignature(fn);
  const jsDoc = jsDocText(fn);
  const isExported = fn.isExported();
  const content = fn.getText();

  const body = fn.getBody();
  const statements = Node.isBlock(body) ? body.getStatements() : [];

  if (estimateTokens(content) <= MAX_TOKENS || statements.length === 0) {
    return [
      buildChunk({
        candidate,
        symbolName: name,
        kind: 'function',
        signature,
        jsDoc,
        startLine: fn.getStartLineNumber(),
        endLine: fn.getEndLineNumber(),
        parentSymbol: null,
        isExported,
        content,
      }),
    ];
  }

  const sourceLines = fn.getSourceFile().getFullText().split('\n');
  const windows = tagParts(packStatementsByBudget(sourceLines, statements));

  return windows.map((w) =>
    buildChunk({
      candidate,
      symbolName: name,
      kind: 'function',
      signature,
      jsDoc,
      startLine: w.startLine,
      endLine: w.endLine,
      parentSymbol: null,
      isExported,
      content: w.content,
      partIndex: w.partIndex,
      partTotal: w.partTotal,
    }),
  );
}

function interfaceSignature(iface: InterfaceDeclaration): string {
  const extendsClauses = iface.getExtends();
  const extendsText = extendsClauses.length > 0 ? ` extends ${extendsClauses.map((e) => e.getText()).join(', ')}` : '';
  return `${modifiersPrefix(iface)}interface ${iface.getName()}${typeParamsSuffix(iface)}${extendsText}`;
}

function interfaceChunks(candidate: Candidate, iface: InterfaceDeclaration): Chunk[] {
  return maybeSplit(
    {
      candidate,
      symbolName: iface.getName(),
      kind: 'interface',
      signature: interfaceSignature(iface),
      jsDoc: jsDocText(iface),
      parentSymbol: null,
      isExported: iface.isExported(),
    },
    iface.getStartLineNumber(),
    iface.getEndLineNumber(),
    iface.getText(),
  );
}

// Condenses a type node to a short signature fragment instead of serialising it whole —
// the same "compose from fields, never getText the whole node" rule applied to functions.
function condensedTypeText(typeNode: TypeNode): string {
  if (Node.isTypeLiteral(typeNode)) {
    const memberNames = typeNode.getMembers().map((m) =>
      Node.isPropertySignature(m) || Node.isMethodSignature(m) ? m.getName() : m.getKindName(),
    );
    return `{ ${memberNames.join('; ')} }`;
  }
  if (Node.isUnionTypeNode(typeNode)) {
    return typeNode
      .getTypeNodes()
      .map((t) => condensedTypeText(t))
      .join(' | ');
  }
  if (Node.isIntersectionTypeNode(typeNode)) {
    return typeNode
      .getTypeNodes()
      .map((t) => condensedTypeText(t))
      .join(' & ');
  }
  return typeNode.getText();
}

function typeAliasSignature(alias: TypeAliasDeclaration): string {
  const typeNode = alias.getTypeNode();
  const typeText = typeNode ? condensedTypeText(typeNode) : '';
  return `${modifiersPrefix(alias)}type ${alias.getName()}${typeParamsSuffix(alias)} = ${typeText}`;
}

function typeAliasChunks(candidate: Candidate, alias: TypeAliasDeclaration): Chunk[] {
  return maybeSplit(
    {
      candidate,
      symbolName: alias.getName(),
      kind: 'type-alias',
      signature: typeAliasSignature(alias),
      jsDoc: jsDocText(alias),
      parentSymbol: null,
      isExported: alias.isExported(),
    },
    alias.getStartLineNumber(),
    alias.getEndLineNumber(),
    alias.getText(),
  );
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
    startLine: enumDecl.getStartLineNumber(),
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
  return typeNode ? `const ${name}: ${condensedTypeText(typeNode)}` : `const ${name}`;
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
    startLine: statement.getStartLineNumber(),
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

function wholeFileChunks(candidate: Candidate, sourceFile: SourceFile): Chunk[] {
  const content = sourceFile.getFullText();
  const lastLine = sourceFile.getEndLineNumber();
  return maybeSplit(
    {
      candidate,
      symbolName: null,
      kind: 'file',
      signature: null,
      jsDoc: null,
      parentSymbol: null,
      isExported: false,
    },
    1,
    lastLine,
    content,
  );
}

function collectChunks(candidate: Candidate, sourceFile: SourceFile): Chunk[] {
  const chunks: Chunk[] = [];
  let hasReExport = false;

  for (const statement of sourceFile.getStatements()) {
    if (Node.isClassDeclaration(statement)) {
      chunks.push(...classChunks(candidate, statement));
    } else if (Node.isFunctionDeclaration(statement)) {
      chunks.push(...functionChunks(candidate, statement));
    } else if (Node.isInterfaceDeclaration(statement)) {
      chunks.push(...interfaceChunks(candidate, statement));
    } else if (Node.isTypeAliasDeclaration(statement)) {
      chunks.push(...typeAliasChunks(candidate, statement));
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
  const windows = tagParts(splitByLines(source, 1, MAX_TOKENS));
  return windows.map((w) =>
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
      partIndex: w.partIndex,
      partTotal: w.partTotal,
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
        return { ok: true, value: { chunks: wholeFileChunks(candidate, sourceFile), outcome: 'no-declarations' } };
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
