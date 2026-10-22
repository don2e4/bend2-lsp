#!/usr/bin/env node
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CompletionItemKind, createConnection, DiagnosticSeverity, FoldingRangeKind, MarkupKind, ProposedFeatures, SymbolKind, TextDocuments, TextDocumentSyncKind,
  type CompletionItem, type Diagnostic, type DocumentSymbol, type FoldingRange, type Hover, type InitializeResult, type Location, type TextEdit,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { Analyzer } from "./analysis.js";
import { formatBend } from "./formatter.js";
import { hubImport, KEYWORDS, lexicalDiagnostics, staticHover } from "./lexical.js";
import { declarations, foldingRanges } from "./outline.js";
import type { AnalysisDiagnostic, AnalysisResult, CompletionEntry, Overlay } from "./protocol.js";

const VERSION = "0.2.0";
const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);
const analyzer = new Analyzer();
const timers = new Map<string, NodeJS.Timeout>();
const results = new Map<string, AnalysisResult>();
// The newest analysis of each document, kept while it is edited again, so
// completion still knows the names in scope.
const lastResults = new Map<string, AnalysisResult>();
const imports = new Map<string, Set<string>>();

function supported(document: TextDocument): boolean {
  return document.languageId === "bend" || document.languageId === "bend2";
}

function filePath(uri: string): string | null {
  try { return uri.startsWith("file:") ? fileURLToPath(uri) : null; } catch { return null; }
}

function importUris(document: TextDocument): Set<string> {
  const found = new Set<string>();
  if (!filePath(document.uri)) return found;
  for (const line of document.getText().split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = /^import\s+(\S+)\s+as\s+[A-Za-z_][A-Za-z0-9_]*\s*(?:#.*)?$/.exec(trimmed);
    if (match && !hubImport(match[1])) {
      try { found.add(new URL(match[1], document.uri).href); } catch { /* Invalid import paths belong in compiler diagnostics. */ }
    }
    else if (trimmed !== "import Base") break;
  }
  return found;
}

function dependentsOf(uri: string): Set<string> {
  const result = new Set([uri]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [candidate, deps] of imports) {
      if (![...deps].some((dep) => result.has(dep)) || result.has(candidate)) continue;
      result.add(candidate);
      changed = true;
    }
  }
  return result;
}

function overlays(): Overlay[] {
  return documents.all().flatMap((document) => {
    const path = filePath(document.uri);
    return path ? [{ uri: document.uri, path, version: document.version, text: document.getText() }] : [];
  });
}

function diagnostic(document: TextDocument, item: Omit<AnalysisDiagnostic, "uri">): Diagnostic {
  return {
    range: { start: document.positionAt(item.range.start), end: document.positionAt(item.range.end) },
    message: item.message, severity: item.severity === "warning" ? DiagnosticSeverity.Warning : DiagnosticSeverity.Error, source: "bend2", code: item.code,
  };
}

function lexical(document: TextDocument): Diagnostic[] {
  return lexicalDiagnostics(document.getText()).map((item) => diagnostic(document, item));
}

function targets(result: AnalysisResult): Set<string> {
  return new Set([result.uri, ...result.diagnostics.map((item) => item.uri)]);
}

function fresh(result: AnalysisResult): boolean {
  return Object.entries(result.versions).every(([uri, version]) => documents.get(uri)?.version === version);
}

function publish(uri: string): void {
  const document = documents.get(uri);
  if (!document || !supported(document)) return;
  const lex = lexical(document);
  const lexicalPositions = new Set(lex.map((item) => `${item.code}:${item.range.start.line}:${item.range.start.character}`));
  const seen = new Set<string>();
  const compiler: Diagnostic[] = [];
  for (const result of results.values()) {
    if (!fresh(result)) continue;
    for (const item of result.diagnostics) {
      if (item.uri !== uri) continue;
      const converted = diagnostic(document, item);
      const position = `${converted.code}:${converted.range.start.line}:${converted.range.start.character}`;
      const key = `${position}:${converted.message}`;
      if (!lexicalPositions.has(position) && !seen.has(key)) { seen.add(key); compiler.push(converted); }
    }
  }
  connection.sendDiagnostics({ uri, version: document.version, diagnostics: [...lex, ...compiler] });
}

function invalidate(uris: Set<string>): void {
  const affected = new Set<string>(uris);
  for (const uri of uris) {
    const old = results.get(uri);
    if (old) for (const target of targets(old)) affected.add(target);
    results.delete(uri);
  }
  for (const uri of affected) publish(uri);
}

async function analyze(uri: string): Promise<void> {
  const document = documents.get(uri);
  if (!document || !supported(document)) return;
  const version = document.version;
  const path = filePath(uri);
  if (!path) {
    publish(uri);
    return;
  }
  const result = await analyzer.analyze({ type: "analyze", uri, path, version, text: document.getText(), overlays: overlays() });
  const current = documents.get(uri);
  if (current) lastResults.set(uri, result);
  if (!current || current.version !== result.version || !fresh(result)) return;
  const old = results.get(uri);
  results.set(uri, result);
  const affected = targets(result);
  if (old) for (const target of targets(old)) affected.add(target);
  for (const target of affected) publish(target);
}

function schedule(uri: string, delay = 250): void {
  const old = timers.get(uri);
  if (old) clearTimeout(old);
  timers.set(uri, setTimeout(() => {
    timers.delete(uri);
    void analyze(uri).catch((error) => connection.console.error(error instanceof Error ? error.stack ?? error.message : String(error)));
  }, delay));
}

connection.onInitialize((): InitializeResult => ({
  capabilities: {
    textDocumentSync: TextDocumentSyncKind.Full, documentFormattingProvider: true, hoverProvider: true, definitionProvider: true,
    completionProvider: { triggerCharacters: ["."] }, documentSymbolProvider: true, foldingRangeProvider: true,
  },
  serverInfo: { name: "bend2-lsp", version: VERSION },
}));

connection.onDocumentFormatting((params): TextEdit[] => {
  const document = documents.get(params.textDocument.uri);
  if (!document || !supported(document)) return [];
  const source = document.getText();
  const formatted = formatBend(source, params.options);
  if (formatted === source) return [];
  return [{ range: { start: { line: 0, character: 0 }, end: document.positionAt(source.length) }, newText: formatted }];
});

function tokenAt(document: TextDocument, offset: number): string {
  const source = document.getText();
  for (const token of ["{==}", "<&>", "->", "=>", "==", "!=", "&0", "&1", "&2"]) {
    const start = source.lastIndexOf(token, offset);
    if (start >= 0 && start <= offset && offset <= start + token.length) return token;
  }
  if (source[offset] === "%" || source[offset] === "!") return source[offset];
  let start = offset;
  let end = offset;
  while (start > 0 && /[A-Za-z0-9_./]/.test(source[start - 1])) start--;
  while (end < source.length && /[A-Za-z0-9_./]/.test(source[end])) end++;
  if (start === end && /[%!]/.test(source[offset] ?? source[offset - 1] ?? "")) return source[offset] ?? source[offset - 1];
  return source.slice(start, end);
}

// A name written `Name{` is a constructor, which may share its type's name.
function named<T>(table: Record<string, T>, document: TextDocument, offset: number, token: string): T | undefined {
  const source = document.getText();
  let end = offset;
  while (end < source.length && /[A-Za-z0-9_./]/.test(source[end])) end++;
  return (source[end] === "{" ? table[`${token}{}`] : undefined) ?? table[token];
}

function lineAt(document: TextDocument, line: number): string {
  return document.getText().split(/\r?\n/)[line] ?? "";
}

// Whether a column of a line is code, rather than inside a literal or comment.
function inCode(line: string, character: number): boolean {
  let quote = "";
  let escaped = false;
  for (const char of line.slice(0, character)) {
    if (escaped) escaped = false;
    else if (char === "\\" && quote) escaped = true;
    else if (char === quote) quote = "";
    else if (!quote && (char === '"' || char === "'")) quote = char;
    else if (!quote && char === "#") return false;
  }
  return !quote;
}

connection.onHover((params): Hover | null => {
  const document = documents.get(params.textDocument.uri);
  if (!document || !supported(document)) return null;
  const offset = document.offsetAt(params.position);
  const token = tokenAt(document, offset);
  const result = results.get(document.uri);
  const value = staticHover(token) ?? (result && fresh(result) ? named(result.hovers, document, offset, token) : undefined);
  return value ? { contents: { kind: MarkupKind.Markdown, value } } : null;
});

connection.onDefinition((params): Location | null => {
  const document = documents.get(params.textDocument.uri);
  if (!document || !supported(document)) return null;
  const line = lineAt(document, params.position.line);
  const imported = /^\s*import\s+(\S+)\s+as\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:#.*)?$/.exec(line);
  if (imported && filePath(document.uri) && imported[1].endsWith(".bend") && !isAbsolute(imported[1]) && !hubImport(imported[1])) {
    const pathStart = line.indexOf(imported[1]);
    const aliasStart = line.indexOf(imported[2], pathStart + imported[1].length);
    const column = params.position.character;
    if ((column >= pathStart && column < pathStart + imported[1].length) || (column >= aliasStart && column < aliasStart + imported[2].length)) {
      try {
        const target = new URL(imported[1], document.uri).href;
        const file = filePath(target);
        if (file && (documents.get(target) || existsSync(file))) return { uri: target, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } };
      } catch { return null; }
    }
  }
  if (!inCode(line, params.position.character)) return null;
  const result = results.get(document.uri);
  if (!result || !fresh(result)) return null;
  const offset = document.offsetAt(params.position);
  return named(result.definitions, document, offset, tokenAt(document, offset)) ?? null;
});

const COMPLETION_KINDS: Record<CompletionEntry["kind"], CompletionItemKind> = {
  def: CompletionItemKind.Function, law: CompletionItemKind.Constant, type: CompletionItemKind.Struct, constructor: CompletionItemKind.Constructor,
};

connection.onCompletion((params): CompletionItem[] => {
  const document = documents.get(params.textDocument.uri);
  if (!document || !supported(document)) return [];
  const line = lineAt(document, params.position.line);
  if (!inCode(line, params.position.character)) return [];
  let start = params.position.character;
  while (start > 0 && /[A-Za-z0-9_.]/.test(line[start - 1])) start--;
  // The edit spans the whole dotted prefix, so `Dep.an` filters `Dep.answer`.
  const range = { start: { line: params.position.line, character: start }, end: params.position };
  const item = (label: string, kind: CompletionItemKind, detail?: string, documentation?: string): CompletionItem => ({
    label, kind, detail, filterText: label, textEdit: { range, newText: label },
    ...(documentation ? { documentation: { kind: MarkupKind.Markdown, value: documentation } } : {}),
  });
  const entries = lastResults.get(document.uri)?.completions ?? [];
  return [...KEYWORDS.map((word) => item(word, CompletionItemKind.Keyword)), ...entries.map((entry) => item(entry.label, COMPLETION_KINDS[entry.kind], entry.detail, entry.documentation))];
});

const SYMBOL_KINDS: Record<CompletionEntry["kind"], SymbolKind> = {
  def: SymbolKind.Function, law: SymbolKind.Constant, type: SymbolKind.Struct, constructor: SymbolKind.Constructor,
};

connection.onDocumentSymbol((params): DocumentSymbol[] => {
  const document = documents.get(params.textDocument.uri);
  if (!document || !supported(document)) return [];
  const text = document.getText();
  const items = declarations(text);
  const symbols = items.map((item): DocumentSymbol => ({
    name: item.name, detail: item.detail || undefined, kind: SYMBOL_KINDS[item.kind], children: [],
    range: { start: document.positionAt(text.lastIndexOf("\n", item.start - 1) + 1), end: document.positionAt(item.blockEnd) },
    selectionRange: { start: document.positionAt(item.start), end: document.positionAt(item.end) },
  }));
  for (const [index, item] of items.entries()) if (item.parent !== undefined) symbols[item.parent].children!.push(symbols[index]);
  return symbols.filter((_, index) => items[index].parent === undefined);
});

connection.onFoldingRanges((params): FoldingRange[] => {
  const document = documents.get(params.textDocument.uri);
  if (!document || !supported(document)) return [];
  return foldingRanges(document.getText()).map((fold) => ({
    startLine: fold.startLine, endLine: fold.endLine,
    ...(fold.kind ? { kind: fold.kind === "comment" ? FoldingRangeKind.Comment : FoldingRangeKind.Imports } : {}),
  }));
});

documents.onDidOpen(({ document }) => {
  if (!supported(document)) return;
  imports.set(document.uri, importUris(document));
  const affected = dependentsOf(document.uri);
  invalidate(affected);
  for (const uri of affected) schedule(uri, 0);
});
documents.onDidChangeContent(({ document }) => {
  if (!supported(document)) return;
  imports.set(document.uri, importUris(document));
  const affected = dependentsOf(document.uri);
  invalidate(affected);
  for (const uri of affected) schedule(uri);
});
documents.onDidClose(({ document }) => {
  const timer = timers.get(document.uri);
  if (timer) clearTimeout(timer);
  timers.delete(document.uri);
  imports.delete(document.uri);
  lastResults.delete(document.uri);
  const affected = dependentsOf(document.uri);
  invalidate(affected);
  connection.sendDiagnostics({ uri: document.uri, diagnostics: [] });
  for (const uri of affected) if (uri !== document.uri) schedule(uri);
});

connection.onShutdown(async () => { await analyzer.close(); });
documents.listen(connection);
connection.listen();
