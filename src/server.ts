#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, watchFile, unwatchFile } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  CompletionItemKind, createConnection, DiagnosticSeverity, FoldingRangeKind, LSPErrorCodes, MarkupKind, ProposedFeatures, ResponseError, SymbolKind, TextDocuments, TextDocumentSyncKind,
  type CompletionItem, type Diagnostic, type DocumentSymbol, type FoldingRange, type Hover, type InitializeResult, type Location, type Position, type Range, type TextEdit, type WorkspaceEdit,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { Analyzer } from "./analysis.js";
import { formatBend } from "./formatter.js";
import { hubImport, KEYWORDS, lexicalDiagnostics, staticHover } from "./lexical.js";
import { declarations, foldingRanges } from "./outline.js";
import type { AnalysisDiagnostic, AnalysisResult, CompletionEntry, Overlay, Reference } from "./protocol.js";

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
const analysisDependencies = new Map<string, Set<string>>();
const watched = new Set<string>();
let workspaceRoots: string[] = [];
let proofEntrypoint: string | false | undefined;
let generation = 0;

function workspaceRoot(file: string): string | undefined {
  return workspaceRoots.find((root) => {
    const rest = relative(root, file);
    return rest === "" || (!isAbsolute(rest) && rest !== ".." && !rest.startsWith(`..${sep}`));
  });
}

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
    for (const [candidate, deps] of [...imports, ...analysisDependencies]) {
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
  return Object.entries(result.versions).every(([uri, version]) => documents.get(uri)?.version === version) &&
    (result.dependencies ?? []).every((uri) => documents.get(uri)?.version === result.versions[uri]);
}

// Watch only files used by open analyses. This also handles proof files that
// are never opened in the editor, and creation/deletion of PROOF.bend.
function watchDependencies(): void {
  const wanted = new Set([...analysisDependencies.values()].flatMap((items) => [...items]));
  for (const uri of watched) if (!wanted.has(uri)) {
    unwatchFile(filePath(uri)!);
    watched.delete(uri);
  }
  for (const uri of wanted) {
    const file = filePath(uri);
    if (!file || watched.has(uri)) continue;
    watched.add(uri);
    watchFile(file, { persistent: false, interval: 750 }, (current, previous) => {
      if (current.mtimeMs === previous.mtimeMs && current.size === previous.size && current.ino === previous.ino) return;
      if (!documents.get(uri)) changed(uri);
    });
  }
}

function changed(uri: string, delay = 250): void {
  generation++;
  const affected = dependentsOf(uri);
  invalidate(affected);
  for (const candidate of affected) if (documents.get(candidate)) schedule(candidate, delay);
}

function publish(uri: string): void {
  const document = documents.get(uri);
  if (!document || !supported(document)) return;
  const lex = lexical(document);
  const lexicalPositions = new Set(lex.map((item) => `${item.code}:${item.range.start.line}:${item.range.start.character}`));
  const seen = new Set<string>();
  const compiler: Diagnostic[] = [];
  // Every open file has its own selected compilation context. Unioning other
  // roots' results can resurrect an "unproved" law that this context proves.
  const result = results.get(uri);
  if (result && fresh(result)) {
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

function request(document: TextDocument, path: string): Promise<AnalysisResult> {
  return analyzer.analyze({ type: "analyze", uri: document.uri, path, version: document.version, text: document.getText(), overlays: overlays(), workspaceRoot: workspaceRoot(path), proofEntrypoint });
}

async function analyze(uri: string): Promise<void> {
  const document = documents.get(uri);
  if (!document || !supported(document)) return;
  const path = filePath(uri);
  if (!path) {
    publish(uri);
    return;
  }
  const started = generation;
  const result = await request(document, path);
  const current = documents.get(uri);
  if (!current) return;
  if (started !== generation || current.version !== result.version || !fresh(result)) { schedule(uri); return; }
  lastResults.set(uri, result);
  analysisDependencies.set(uri, new Set(result.dependencies ?? []));
  watchDependencies();
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

connection.onInitialize((params): InitializeResult => {
  workspaceRoots = (params.workspaceFolders?.length ? params.workspaceFolders.map((folder) => filePath(folder.uri)) : [params.rootUri ? filePath(params.rootUri) : params.rootPath])
    .filter((root): root is string => typeof root === "string").sort((a, b) => b.length - a.length);
  const entry: unknown = params.initializationOptions?.proofEntrypoint;
  proofEntrypoint = entry === false || (typeof entry === "string" && entry.trim() !== "") ? entry : undefined;
  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Full, documentFormattingProvider: true, hoverProvider: true, definitionProvider: true,
      completionProvider: { triggerCharacters: ["."] }, documentSymbolProvider: true, foldingRangeProvider: true,
      referencesProvider: true, renameProvider: params.capabilities.textDocument?.rename?.prepareSupport ? { prepareProvider: true } : true,
    },
    serverInfo: { name: "bend2-lsp", version: VERSION },
  };
});

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

type Found = { result: AnalysisResult; group: Reference; location: Location };

// The name under the cursor, which may sit at either end of it.
function referenceAt(uri: string, position: Position): Found | undefined {
  const result = results.get(uri);
  if (!result || !fresh(result)) return undefined;
  for (const group of result.references) {
    for (const location of [...group.declarations, ...group.uses]) {
      const { start, end } = location.range;
      if (location.uri === uri && start.line === position.line && start.character <= position.character && position.character <= end.character) return { result, group, location };
    }
  }
  return undefined;
}

// shortcut: a synchronous walk of at most 10000 directories, enough for a project; index workspace files if roots outgrow it.
function bendFiles(root: string): string[] {
  const found: string[] = [];
  const todo = [root];
  for (let visited = 0; todo.length > 0 && visited < 10_000; visited++) {
    const directory = todo.pop()!;
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      if (entry.isDirectory()) todo.push(join(directory, entry.name));
      else if (entry.name.endsWith(".bend")) found.push(join(directory, entry.name));
    }
  }
  return found;
}

// A file can name a declaration only by importing its file, so the workspace
// files that do are analyzed now, unless an open document's analysis is current.
function importers(group: Reference): Promise<AnalysisResult[]> {
  const homes = new Set(group.declarations.map((item) => filePath(item.uri)));
  const open = new Map(documents.all().map((document) => [filePath(document.uri), document]));
  const pending: Promise<AnalysisResult>[] = [];
  for (const file of new Set(workspaceRoots.flatMap(bendFiles))) {
    let document = open.get(file);
    try { document ??= TextDocument.create(pathToFileURL(file).href, "bend", 0, readFileSync(file, "utf8")); } catch { continue; }
    const known = results.get(document.uri);
    if (known && fresh(known)) continue;
    if ([...importUris(document)].some((uri) => homes.has(filePath(uri)))) pending.push(request(document, file));
  }
  return Promise.all(pending);
}

// One name across every analysis that declares it at the same place: each
// open file is checked in its own context, so no single analysis sees all uses.
async function gather(uri: string, position: Position): Promise<Reference | undefined> {
  const seed = referenceAt(uri, position);
  if (!seed) return undefined;
  const extra = seed.group.renameable ? await importers(seed.group) : [];
  // The wait may have outlived an edit, and stale positions would misplace a rename.
  if (!fresh(seed.result)) return undefined;
  const id = (item: Location) => `${item.uri}#${item.range.start.line}:${item.range.start.character}`;
  const same = new Set(seed.group.declarations.map(id));
  const declarations = new Map<string, Location>();
  const uses = new Map<string, Location>();
  let renameable = seed.group.renameable;
  for (const result of new Set([seed.result, ...results.values(), ...extra])) {
    if (!fresh(result)) continue;
    for (const group of result.references) {
      if (group !== seed.group && !group.declarations.some((item) => same.has(id(item)))) continue;
      renameable &&= group.renameable;
      for (const item of group.declarations) declarations.set(id(item), item);
      for (const item of group.uses) uses.set(id(item), item);
    }
  }
  for (const key of declarations.keys()) uses.delete(key);
  return { declarations: [...declarations.values()], uses: [...uses.values()], renameable };
}

const NOT_RENAMEABLE = "Names from Base and hub packages cannot be renamed.";

connection.onReferences(async (params): Promise<Location[]> => {
  const group = await gather(params.textDocument.uri, params.position);
  return group ? [...(params.context.includeDeclaration ? group.declarations : []), ...group.uses] : [];
});

connection.onPrepareRename((params): { range: Range; placeholder: string } | null => {
  const found = referenceAt(params.textDocument.uri, params.position);
  if (!found) return null;
  if (!found.group.renameable) throw new ResponseError(LSPErrorCodes.RequestFailed, NOT_RENAMEABLE);
  return { range: found.location.range, placeholder: documents.get(params.textDocument.uri)!.getText(found.location.range) };
});

connection.onRenameRequest(async (params): Promise<WorkspaceEdit | null> => {
  if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(params.newName) || KEYWORDS.includes(params.newName)) throw new ResponseError(LSPErrorCodes.RequestFailed, `'${params.newName}' is not a Bend name.`);
  const group = await gather(params.textDocument.uri, params.position);
  if (!group) return null;
  if (!group.renameable) throw new ResponseError(LSPErrorCodes.RequestFailed, NOT_RENAMEABLE);
  const changes: Record<string, TextEdit[]> = {};
  for (const item of [...group.declarations, ...group.uses]) (changes[item.uri] ??= []).push({ range: item.range, newText: params.newName });
  return { changes };
});

documents.onDidOpen(({ document }) => {
  if (!supported(document)) return;
  imports.set(document.uri, importUris(document));
  changed(document.uri, 0);
});
documents.onDidChangeContent(({ document }) => {
  if (!supported(document)) return;
  imports.set(document.uri, importUris(document));
  changed(document.uri);
});
documents.onDidClose(({ document }) => {
  generation++;
  const timer = timers.get(document.uri);
  if (timer) clearTimeout(timer);
  timers.delete(document.uri);
  imports.delete(document.uri);
  lastResults.delete(document.uri);
  const affected = dependentsOf(document.uri);
  invalidate(affected);
  analysisDependencies.delete(document.uri);
  watchDependencies();
  connection.sendDiagnostics({ uri: document.uri, diagnostics: [] });
  for (const uri of affected) if (uri !== document.uri) schedule(uri);
});

connection.onDidChangeWatchedFiles(({ changes }) => {
  for (const change of changes) if (!documents.get(change.uri)) changed(change.uri);
});
connection.onShutdown(async () => {
  for (const uri of watched) unwatchFile(filePath(uri)!);
  await analyzer.close();
});
documents.listen(connection);
connection.listen();
