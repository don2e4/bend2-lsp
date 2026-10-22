import { parentPort } from "node:worker_threads";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
  BASE_BEND,
  book_load,
  book_nil,
  book_valid,
  err_show,
  name_show,
  term_lower,
  term_show,
  type Book,
  type Err,
  type File,
} from "../vendor/bend2/bend.js";
import { hubImport, lexicalDiagnostics } from "./lexical.js";
import { declarations, type Declaration } from "./outline.js";
import type { AnalysisDiagnostic, AnalysisRequest, AnalysisResult, CompletionEntry, Location, Overlay } from "./protocol.js";

type Source = { original: string; staged: string; uri: string; text: string; namespace: string; aliases: Map<string, string>; version?: number };
type Declared = Declaration & { key: string; source: Source };

const nativeFetch = globalThis.fetch;
globalThis.fetch = (input, init = {}) => {
  const timeout = AbortSignal.timeout(10_000);
  return nativeFetch(input, { ...init, signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout });
};

const mirrorRoot = path.join(os.tmpdir(), `bend2-lsp-${process.pid}`);

function key(file: string): string {
  const resolved = path.resolve(file).replaceAll("\\", "/");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function compilerPath(file: string): string {
  return file.replaceAll("\\", "/");
}

function mirrorPath(file: string, runRoot: string): string {
  const absolute = path.resolve(file);
  const root = path.parse(absolute).root;
  const volume = root.replace(/[^A-Za-z0-9]/g, "") || "root";
  return path.join(runRoot, volume, absolute.slice(root.length));
}

function imports(text: string): Array<{ relative: string; alias: string }> {
  const found: Array<{ relative: string; alias: string }> = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = /^import\s+(\S+)\s+as\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:#.*)?$/.exec(trimmed);
    if (match) found.push({ relative: match[1], alias: match[2] });
    else if (trimmed !== "import Base") break;
  }
  return found;
}

function compilerSource(text: string): string {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith("#")) continue;
    if (/^import(?:\s|$)/.test(line)) lines[i] = "";
    else break;
  }
  return lines.join("\n");
}

// As the compiler names modules: by path from the entry file's directory.
function namespaceOf(top: string, file: string): string {
  return path.relative(top, file).replaceAll("\\", "/").replace(/\.bend$/, "");
}

function stageGraph(root: string, overlays: Overlay[], runRoot: string): { entry: string; sources: Source[] } {
  const overlay = new Map(overlays.map((item) => [key(item.path), item]));
  const top = path.dirname(root);
  const sources: Source[] = [];
  const seen = new Set<string>();
  function stage(file: string, namespace: string): void {
    const id = key(file);
    if (seen.has(id)) return;
    seen.add(id);
    const open = overlay.get(id);
    if (!open && !fs.existsSync(file)) return;
    const text = open?.text ?? fs.readFileSync(file, "utf8");
    const staged = mirrorPath(file, runRoot);
    fs.mkdirSync(path.dirname(staged), { recursive: true });
    fs.writeFileSync(staged, text);
    const source: Source = { original: file, staged, uri: open?.uri ?? pathToFileURL(file).href, text, namespace, aliases: new Map(), version: open?.version };
    sources.push(source);
    for (const imported of imports(text)) {
      if (/^0x[0-9a-f]+\//.test(imported.relative)) source.aliases.set(imported.alias, imported.relative.replace(/\.bend$/, ""));
      if (hubImport(imported.relative) || path.isAbsolute(imported.relative)) continue;
      const child = path.resolve(path.dirname(file), imported.relative);
      source.aliases.set(imported.alias, namespaceOf(top, child));
      stage(child, namespaceOf(top, child));
    }
  }
  stage(root, "");
  return { entry: mirrorPath(root, runRoot), sources };
}

function offsetRange(source: string, beg: number, end: number): { start: number; end: number } {
  const start = Math.max(0, Math.min(source.length, beg));
  return { start, end: Math.max(start, Math.min(source.length, end)) };
}

function errorCode(error: Err, checking: boolean): AnalysisDiagnostic["code"] {
  const expected = typeof error.exp === "string" ? error.exp : "";
  if (/import|file|hash|namespace|cycle|package|BEND_HUB/i.test(expected)) return "imports";
  return checking ? "checking" : "parsing";
}

// The span already places the error, so its printed location is dropped; a
// note the compiler adds after it stays.
function errorMessage(error: Err): string {
  const shown = err_show({ ...error, nte: undefined }).replace(/\nLocation:[\s\S]*$/, "").trim();
  return error.nte ? `${shown}\n${error.nte.trim()}` : shown;
}

function sourceForSpan(sources: Source[], file: File): Source | undefined {
  return sources.find((source) => source.text === file.str || compilerSource(source.text) === file.str)
    ?? sources.find((source) => source.namespace === file.ns && file.ns !== "");
}

function originalOffset(source: Source, spanSource: string, offset: number): number {
  if (spanSource === source.text) return offset;
  const before = spanSource.slice(0, offset);
  const line = before.split("\n").length - 1;
  const column = offset - before.lastIndexOf("\n") - 1;
  const lines = source.text.split("\n");
  let result = 0;
  for (let i = 0; i < line; i++) result += (lines[i]?.length ?? 0) + 1;
  return result + column;
}

function position(text: string, offset: number): Location["range"]["start"] {
  const lines = text.slice(0, offset).split("\n");
  return { line: lines.length - 1, character: lines.at(-1)!.length };
}

function location(item: Declared): Location {
  return { uri: item.source.uri, range: { start: position(item.source.text, item.start), end: position(item.source.text, item.end) } };
}

// A declared name's book key: `ns:name`, through an alias when it fills an
// imported law, bare in the entry file and Base.
function keyOf(source: Source, name: string): string {
  const dot = name.indexOf(".");
  const namespace = dot > 0 ? source.aliases.get(name.slice(0, dot)) : undefined;
  if (namespace !== undefined) return `${namespace}:${name.slice(dot + 1)}`;
  return source.namespace ? `${source.namespace}:${name}` : name;
}

function declare(sources: Source[]): Declared[] {
  return sources.flatMap((source) => declarations(source.text).map((item) => ({ ...item, key: keyOf(source, item.name), source })));
}

let baseDeclared: Declared[] | undefined;
function baseDeclarations(): Declared[] {
  if (!baseDeclared) {
    const text = fs.readFileSync(BASE_BEND, "utf8");
    baseDeclared = declare([{ original: BASE_BEND, staged: BASE_BEND, uri: pathToFileURL(BASE_BEND).href, text, namespace: "", aliases: new Map() }]);
  }
  return baseDeclared;
}

// The first declaration of each key in the file that owns its namespace, so
// a law wins over the proof that fills it from another file.
function index(declared: Declared[], constructors: boolean): Map<string, Declared> {
  const found = new Map<string, Declared>();
  for (const home of [true, false]) {
    for (const item of declared) {
      if ((item.kind === "constructor") !== constructors || found.has(item.key)) continue;
      const namespace = item.key.includes(":") ? item.key.slice(0, item.key.indexOf(":")) : "";
      if ((item.source.namespace === namespace) === home) found.set(item.key, item);
    }
  }
  return found;
}

function hoverText(kind: string, name: string, signature: string, doc: string): string {
  return `**${kind} ${name}**\n\n\`\`\`bend\n${name} : ${signature}\n\`\`\`${doc ? `\n\n${doc}` : ""}`;
}

function describe(book: Book, file: File, declared: Declared[]): Pick<AnalysisResult, "hovers" | "definitions" | "completions"> {
  const hovers: Record<string, string> = Object.create(null) as Record<string, string>;
  const definitions: Record<string, Location> = Object.create(null) as Record<string, Location>;
  const completions: CompletionEntry[] = [];
  const named = new Set(["", ...Object.values(file.al)]);
  const nameable = (key: string) => named.has(key.includes(":") ? key.slice(0, key.indexOf(":")) : "");
  const tlds = index(declared, false);
  const ctrs = index(declared, true);
  for (const [name, tld] of Object.entries(book.tlds)) {
    if (!nameable(name)) continue;
    const shown = name_show(file, name);
    const kind = tld.$ === "ADT" ? "type" : tld.l ? "law" : "def";
    const signature = term_show(term_lower(tld.T), -1, [], file);
    const declaration = tlds.get(name);
    hovers[shown] = hoverText(kind, shown, signature, declaration?.doc ?? "");
    if (declaration) definitions[shown] = location(declaration);
    completions.push({ label: shown, kind, detail: signature, documentation: declaration?.doc || undefined });
  }
  for (const [name, constructor] of Object.entries(book.ctrs)) {
    if (!nameable(name)) continue;
    const shown = name_show(file, name);
    const signature = term_show(term_lower(constructor.T), -1, [], file);
    const declaration = ctrs.get(name);
    const hover = hoverText("constructor", shown, signature, declaration?.doc ?? "");
    hovers[`${shown}{}`] = hover;
    if (!(shown in hovers)) hovers[shown] = hover;
    if (declaration) {
      definitions[`${shown}{}`] = location(declaration);
      if (!(shown in definitions)) definitions[shown] = location(declaration);
    }
    completions.push({ label: shown, kind: "constructor", detail: signature, documentation: declaration?.doc || undefined });
  }
  return { hovers, definitions, completions };
}

function markers(book: Book, sources: Source[], declared: Declared[]): AnalysisDiagnostic[] {
  if (book.hols === 0) return [];
  const found: AnalysisDiagnostic[] = [];
  for (const source of sources) {
    for (const hole of lexicalDiagnostics(source.text)) if (hole.code === "holes") found.push({ uri: source.uri, ...hole });
  }
  const laws = index(declared.filter((item) => item.kind === "law"), false);
  for (const [name, tld] of Object.entries(book.tlds)) {
    if (tld.$ !== "Def" || tld.v !== null || tld.b === true || tld.i) continue;
    const law = laws.get(name);
    if (law) found.push({ uri: law.source.uri, range: { start: law.start, end: law.end }, message: `Law '${law.name}' has no proof.`, code: "incomplete-law" });
  }
  return found;
}

// After bend2/main.ts at the vendored commit (book_promises, term_refs):
// @unsafe and foreign defs are promises the checker takes on trust, and a
// def outside Base that names one, directly or through other defs, is no
// proof. Each def found maps to the path that reaches its promise.
function promises(book: Book): Map<string, { on: string; path: string[] }> {
  const found = new Map<string, { on: string; path: string[] }>();
  const own = [...new Set(book.order)].filter((name) => book.tlds[name].b !== true);
  const names = Object.keys(book.tlds);
  const roots: Array<[string, string[]]> = [
    ["@unsafe", names.filter((name) => { const tld = book.tlds[name]; return tld.$ === "Def" && tld.u === true; })],
    ["foreign", names.filter((name) => { const tld = book.tlds[name]; return tld.$ === "Def" && tld.u !== true && tld.i !== undefined && tld.b !== true; })],
  ];
  if (roots.every(([, items]) => items.length === 0)) return found;
  const uses: Record<string, string[]> = Object.create(null) as Record<string, string[]>;
  const reach = new Set(own);
  for (const name of reach) {
    const tld = book.tlds[name];
    if (tld === undefined) continue;
    const refs = new Set<string>();
    for (const item of tld.$ === "ADT" ? [tld, ...tld.c] : [tld]) termRefs(term_lower(item.T), refs);
    if (tld.$ === "Def" && tld.e !== undefined) termRefs(tld.e, refs);
    for (const ref of refs) {
      (uses[ref] ??= []).push(name);
      reach.add(ref);
    }
  }
  for (const [on, items] of roots) {
    const toward = new Map(items.map((name) => [name, name]));
    for (const name of toward.keys()) for (const user of uses[name] ?? []) if (!toward.has(user)) toward.set(user, name);
    for (const name of own) {
      if (!toward.has(name) || found.has(name)) continue;
      const route = [name];
      while (toward.get(route.at(-1)!) !== route.at(-1)) route.push(toward.get(route.at(-1)!)!);
      found.set(name, { on, path: route });
    }
  }
  return found;
}

function termRefs(term: object, out: Set<string>): void {
  const seen = new Set([term]);
  for (const todo = [term]; todo.length > 0;) {
    const node = todo.pop() as Record<string, unknown>;
    if ((node.$ === "Ref" || node.$ === "ADT") && typeof node.k === "string") out.add(node.k);
    for (const field in node) {
      const value = node[field];
      if (field !== "s" && typeof value === "object" && value !== null && !seen.has(value)) {
        seen.add(value);
        todo.push(value);
      }
    }
  }
}

function hasMain(book: Book): boolean {
  const main = book.tlds.main;
  return main !== undefined && main.$ === "Def" && (main.v !== null || main.i !== undefined);
}

// `bend` prints the verdict for a file without main, so there every def that
// relies on a promise is an error; a program only hears about its laws.
function verdict(book: Book, file: File, sources: Source[], declared: Declared[]): AnalysisDiagnostic[] {
  const found = promises(book);
  if (found.size === 0) return [];
  const program = hasMain(book);
  const severity = program ? "warning" : "error";
  const root = sources[0];
  const shown = (name: string) => name_show(file, name);
  const diagnostics: AnalysisDiagnostic[] = [];
  const reported = new Set<string>();
  for (const item of declared) {
    const reason = found.get(item.key);
    if (item.source !== root || item.kind === "constructor" || !reason || reported.has(item.key)) continue;
    const tld = book.tlds[item.key];
    if (program && !(tld?.$ === "Def" && tld.l)) continue;
    reported.add(item.key);
    const on = reason.on === "@unsafe" ? "@unsafe" : "foreign";
    const message = reason.path.length === 1
      ? `'${shown(item.key)}' is ${on} code, so it is no proof: bend reports SOME PROOFS FAIL.`
      : `'${shown(item.key)}' relies on ${on} code through ${reason.path.slice(1).map(shown).join(" → ")}, so it is no proof: bend reports SOME PROOFS FAIL.`;
    diagnostics.push({ uri: root.uri, range: { start: item.start, end: item.end }, message, code: "verdict", severity });
  }
  if (program) return diagnostics;
  const reachable = (namespace: string) => {
    const result = new Set([namespace]);
    for (const current of result) for (const child of sources.find((source) => source.namespace === current)?.aliases.values() ?? []) result.add(child);
    return result;
  };
  const lines = root.text.split("\n");
  let offset = 0;
  for (const line of lines) {
    const imported = /^(\s*import\s+)(\S+)\s+as\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(line);
    const namespace = imported ? root.aliases.get(imported[3]) : undefined;
    if (imported && namespace !== undefined) {
      const within = reachable(namespace);
      const names = [...found.keys()].filter((name) => name.includes(":") && within.has(name.slice(0, name.indexOf(":"))) && !reported.has(name));
      if (names.length > 0) {
        const start = offset + imported[1].length;
        const message = `Imported defs rely on @unsafe or foreign code (${names.map(shown).join(", ")}), so bend reports SOME PROOFS FAIL. Move them to a file this one does not import.`;
        diagnostics.push({ uri: root.uri, range: { start, end: start + imported[2].length }, message, code: "verdict", severity });
      }
    }
    offset += line.length + 1;
  }
  return diagnostics;
}

// As `bend PROOF.bend` demands, a proof imports the laws beside it.
function proofImportsLaws(request: AnalysisRequest, sources: Source[]): AnalysisDiagnostic[] {
  if (path.basename(request.path) !== "PROOF.bend") return [];
  const laws = path.join(path.dirname(request.path), "LAWS.bend");
  const exists = request.overlays.some((item) => key(item.path) === key(laws)) || fs.existsSync(laws);
  if (!exists || sources.some((source) => key(source.original) === key(laws))) return [];
  return [{ uri: request.uri, range: { start: 0, end: 0 }, message: "PROOF.bend must import ./LAWS.bend.", code: "imports" }];
}

function isBase(file: string): boolean {
  try { return fs.realpathSync(file) === BASE_BEND; } catch { return false; }
}

// Base is the prelude, which go-to-definition opens: checked as user code its
// foreign defs would fail, so it is only described.
async function describeBase(request: AnalysisRequest): Promise<AnalysisResult> {
  const book = book_nil();
  await book_load(book, BASE_BEND, "", new Map());
  const file: File = { str: "", ns: "", al: Object.create(null) as Record<string, string> };
  return { id: request.id, uri: request.uri, version: request.version, versions: { [request.uri]: request.version }, diagnostics: [], ...describe(book, file, baseDeclarations()) };
}

async function analyze(request: AnalysisRequest): Promise<AnalysisResult> {
  if (isBase(request.path)) return describeBase(request);
  const runRoot = path.join(mirrorRoot, String(request.id));
  try {
    const staged = stageGraph(request.path, request.overlays, runRoot);
    const root = staged.sources[0];
    const file: File = { str: "", ns: "", al: Object.assign(Object.create(null) as Record<string, string>, Object.fromEntries(root.aliases)) };
    const declared = [...declare(staged.sources), ...baseDeclarations()];
    const book = book_nil();
    let checking = false;
    const diagnostics: AnalysisDiagnostic[] = [];
    try {
      const done = await book_load(book, compilerPath(staged.entry), "", new Map());
      checking = true;
      book_valid(book, done);
      diagnostics.push(...markers(book, staged.sources, declared), ...verdict(book, file, staged.sources, declared));
    } catch (caught) {
      const error = caught as Partial<Err>;
      if (error.$ === "Err" && error.bok && error.ctx && error.exp !== undefined) {
        const typed = error as Err;
        const spanned = typed.spn ? sourceForSpan(staged.sources, typed.spn.file) : undefined;
        const owner = typed.def === undefined ? undefined : index(declared, false).get(typed.def);
        let target: { uri: string; range: { start: number; end: number } };
        if (typed.spn && spanned) {
          const beg = originalOffset(spanned, typed.spn.file.str, typed.spn.beg);
          const end = originalOffset(spanned, typed.spn.file.str, typed.spn.end);
          target = { uri: spanned.uri, range: offsetRange(spanned.text, beg, end) };
        } else if (owner && owner.source.uri !== pathToFileURL(BASE_BEND).href) {
          target = { uri: owner.source.uri, range: { start: owner.start, end: owner.end } };
        } else target = { uri: request.uri, range: { start: 0, end: 0 } };
        diagnostics.push({ ...target, message: errorMessage(typed), code: errorCode(typed, checking) });
      } else {
        diagnostics.push({ uri: request.uri, range: { start: 0, end: 0 }, message: caught instanceof Error ? caught.message : String(caught), code: checking ? "checking" : "imports" });
      }
    }
    diagnostics.push(...proofImportsLaws(request, staged.sources));
    const versions = Object.fromEntries(staged.sources.flatMap((source) => source.version === undefined ? [] : [[source.uri, source.version]]));
    return { id: request.id, uri: request.uri, version: request.version, versions, diagnostics, ...describe(book, file, declared) };
  } finally {
    fs.rmSync(runRoot, { recursive: true, force: true });
  }
}

// Every request gets an answer, or the server would wait on it forever.
parentPort?.on("message", (request: AnalysisRequest) => {
  if (request.type !== "analyze") return;
  void analyze(request).catch((caught): AnalysisResult => ({
    id: request.id, uri: request.uri, version: request.version, versions: { [request.uri]: request.version },
    diagnostics: [{ uri: request.uri, range: { start: 0, end: 0 }, message: `Analysis failed: ${caught instanceof Error ? caught.message : String(caught)}`, code: "imports" }],
    hovers: {}, definitions: {}, completions: [],
  })).then((result) => parentPort?.postMessage(result));
});

