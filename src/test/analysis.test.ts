import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { Analyzer } from "../analysis.js";
import { lexicalDiagnostics, staticHover } from "../lexical.js";

test("reports lexical errors and documents syntax", () => {
  const diagnostics = lexicalDiagnostics('def main() -> String:\n  "unfinished\n  ?TODO');
  assert.deepEqual(diagnostics.map((item) => item.code), ["parsing", "holes"]);
  assert.match(staticHover("!") ?? "", /GPU/);
  assert.equal(staticHover("unknown"), null);
});

test("ignores hole markers inside comments and literals", () => {
  const source = '# ?TODO\n"?TODO"\n?TODO';
  assert.deepEqual(lexicalDiagnostics(source).map((item) => item.range.start), [source.lastIndexOf("?TODO")]);
});

test("uses the compiler for diagnostics and hover", async () => {
  const analyzer = new Analyzer();
  const file = path.join(os.tmpdir(), `bend2-lsp-test-${process.pid}.bend`);
  const uri = pathToFileURL(file).href;
  const text = "import Base\n\ndef main() -> U32:\n  0";
  const result = await analyzer.analyze({ type: "analyze", uri, path: file, version: 1, text, overlays: [{ uri, path: file, version: 1, text }] });
  await analyzer.close();
  assert.deepEqual(result.diagnostics, []);
  assert.match(result.hovers.main, /main :/);
});

test("resolves an imported unsaved overlay", async () => {
  const analyzer = new Analyzer();
  const dir = path.join(os.tmpdir(), `bend2-lsp-overlay-${process.pid}`);
  const main = path.join(dir, "main.bend");
  const dep = path.join(dir, "dep.bend");
  const mainUri = pathToFileURL(main).href;
  const depUri = pathToFileURL(dep).href;
  const mainText = "import ./dep.bend as Dep\n\ndef main() -> U32:\n  Dep.answer";
  const depText = "import Base\n\ndef answer() -> U32:\n  42";
  const overlays = [{ uri: mainUri, path: main, version: 1, text: mainText }, { uri: depUri, path: dep, version: 2, text: depText }];
  const result = await analyzer.analyze({ type: "analyze", uri: mainUri, path: main, version: 1, text: mainText, overlays });
  await analyzer.close();
  assert.deepEqual(result.diagnostics, []);
  assert.match(result.hovers["Dep.answer"], /answer/);
  assert.deepEqual(result.definitions["Dep.answer"], { uri: depUri, range: { start: { line: 2, character: 4 }, end: { line: 2, character: 10 } } });
  assert.deepEqual(result.versions, { [mainUri]: 1, [depUri]: 2 });
});

test("keeps case-distinct imports separate on case-sensitive filesystems", { skip: process.platform === "win32" }, async () => {
  const analyzer = new Analyzer();
  const dir = path.join(os.tmpdir(), `bend2-lsp-case-${process.pid}`);
  const main = path.join(dir, "main.bend");
  const upper = path.join(dir, "Dep.bend");
  const lower = path.join(dir, "dep.bend");
  const mainText = "import Base\nimport ./Dep.bend as Upper\nimport ./dep.bend as Lower\n\ndef main() -> U32:\n  Upper.answer";
  const overlays = [
    { uri: pathToFileURL(main).href, path: main, version: 1, text: mainText },
    { uri: pathToFileURL(upper).href, path: upper, version: 1, text: "import Base\n\ndef answer() -> U32:\n  1" },
    { uri: pathToFileURL(lower).href, path: lower, version: 1, text: "import Base\n\ndef answer() -> U32:\n  2" },
  ];
  try {
    const result = await analyzer.analyze({ type: "analyze", uri: overlays[0].uri, path: main, version: 1, text: mainText, overlays });
    assert.deepEqual(result.diagnostics, []);
    assert.match(result.hovers["Upper.answer"], /answer/);
    assert.match(result.hovers["Lower.answer"], /answer/);
  } finally {
    await analyzer.close();
  }
});

test("categorizes compiler failures with source offsets", async () => {
  const analyzer = new Analyzer();
  const dir = path.join(os.tmpdir(), `bend2-lsp-errors-${process.pid}`);
  const cases = [
    { name: "parse", text: "import Base\n\ndef main() -> U32:\n  )", code: "parsing", at: ")" },
    { name: "type", text: 'import Base\n\ndef main() -> U32:\n  "no"', code: "checking", at: '"no"' },
    { name: "import", text: "import ./missing.bend as Missing\n\ndef main() -> U32:\n  0", code: "imports", at: "./missing.bend" },
    { name: "hole", text: "import Base\n\ndef main() -> U32:\n  ?TODO", code: "holes", at: "?TODO" },
    { name: "law", text: "import Base\n\nlaw unfinished:\n  {0 == 0 : U32}", code: "incomplete-law", at: "unfinished" },
  ] as const;
  try {
    for (const item of cases) {
      const file = path.join(dir, `${item.name}.bend`);
      const uri = pathToFileURL(file).href;
      const result = await analyzer.analyze({ type: "analyze", uri, path: file, version: 1, text: item.text, overlays: [{ uri, path: file, version: 1, text: item.text }] });
      assert.equal(result.diagnostics[0]?.code, item.code, `${item.name}: ${JSON.stringify(result.diagnostics)}`);
      assert.equal(result.diagnostics[0]?.range.start, item.text.lastIndexOf(item.at), item.name);
    }
  } finally {
    await analyzer.close();
  }
});

test("recovers after the analysis worker exits", { timeout: 5_000 }, async () => {
  const analyzer = new Analyzer();
  const worker = (analyzer as unknown as { worker: { terminate(): Promise<number> } }).worker;
  await worker.terminate();
  const file = path.join(os.tmpdir(), `bend2-lsp-recovery-${process.pid}.bend`);
  const uri = pathToFileURL(file).href;
  const text = "import Base\n\ndef main() -> U32:\n  0";
  try {
    const result = await analyzer.analyze({ type: "analyze", uri, path: file, version: 1, text, overlays: [{ uri, path: file, version: 1, text }] });
    assert.deepEqual(result.diagnostics, []);
  } finally {
    await analyzer.close();
  }
});

async function analyzeFiles(name: string, files: Record<string, string>, analyzer = new Analyzer()) {
  const dir = path.join(os.tmpdir(), `bend2-lsp-${name}-${process.pid}`);
  const overlays = Object.entries(files).map(([file, text]) => ({ uri: pathToFileURL(path.join(dir, file)).href, path: path.join(dir, file), version: 1, text }));
  try {
    return await analyzer.analyze({ type: "analyze", uri: overlays[0].uri, path: overlays[0].path, version: 1, text: overlays[0].text, overlays });
  } finally {
    await analyzer.close();
  }
}

test("checks the Base of Bend 2.0.38", async () => {
  const text = [
    "import Base",
    "",
    "def listen() -> IO(Result<&1, &1, U32 & String, Listener>):",
    '  TCP.listen("127.0.0.1", 8080)',
    "",
    "def bind() -> IO(Result<&1, &1, U32 & String, Socket>):",
    '  UDP.bind("0.0.0.0", 9000)',
    "",
    "def threads() -> IO(U32):",
    "  IO.thread_count()",
    "",
    "def run() -> IO(Result<&1, &1, U32 & String, U32 & (String & String)>):",
    '  Process.run("echo", ["hi"], "", 1024, 1000)',
    "",
    "def send(sock: Socket) -> IO(Socket & Result<&1, &1, (U32 & String) & List<&2, U32>, Unit>):",
    "  TCP.send_bytes(sock, [104, 105])",
    "",
    "def recv(sock: Socket) -> IO(Socket & Result<&1, &1, U32 & String, Maybe<&1, List<&2, U32>>>):",
    "  TCP.recv_bytes(sock, 64)",
  ].join("\n");
  assert.deepEqual((await analyzeFiles("base", { "net.bend": text })).diagnostics, []);
});

test("reports every hole and unproved law", async () => {
  const text = "import Base\n\nlaw first:\n  {0 == 0 : U32}\n\nlaw second:\n  {1 == 1 : U32}\n\ndef a() -> U32:\n  ?TODO\n\ndef b() -> U32:\n  ?TODO\n";
  const result = await analyzeFiles("markers", { "main.bend": text });
  assert.deepEqual(result.diagnostics.map((item) => [item.code, text.slice(item.range.start, item.range.end)]).sort(), [
    ["holes", "?TODO"], ["holes", "?TODO"], ["incomplete-law", "first"], ["incomplete-law", "second"],
  ]);
});

test("keeps the note the compiler adds to an error", async () => {
  const result = await analyzeFiles("note", { "main.bend": "import Base\n\ndef main() -> U32:\n  1 + 2\n" });
  assert.match(result.diagnostics[0]?.message ?? "", /a type for this operator[\s\S]*Note: /);
  assert.doesNotMatch(result.diagnostics[0]?.message ?? "", /Location:/);
});

test("reports proofs that rely on unsafe code as the verdict does", async () => {
  const unsafe = "import Base\n\n@unsafe def spin(n: U32) -> U32:\n  spin(n)\n\ndef helper() -> U32:\n  spin(1)\n\nlaw uses:\n  {helper() == helper() : U32}\n\ndef uses():\n  {==}\n";
  const library = await analyzeFiles("verdict-library", { "main.bend": unsafe });
  assert.deepEqual(library.diagnostics.map((item) => [unsafe.slice(item.range.start, item.range.end), item.severity]), [["spin", "error"], ["helper", "error"], ["uses", "error"]]);
  assert.match(library.diagnostics[2].message, /through helper → spin/);

  const program = await analyzeFiles("verdict-program", { "main.bend": unsafe + "\ndef main() -> U32:\n  helper()\n" });
  assert.deepEqual(program.diagnostics.map((item) => [item.code, item.severity, item.message.split(" ")[0]]), [["verdict", "warning", "'uses'"]]);

  const imported = "import Base\nimport ./lib.bend as Lib\nimport ./LAWS.bend as Laws\n\nlaw zero:\n  {0 == 0 : U32}\n\ndef zero():\n  {==}\n";
  const proof = await analyzeFiles("verdict-import", { "PROOF.bend": imported, "lib.bend": "import Base\n\n@unsafe def spin(n: U32) -> U32:\n  spin(n)\n", "LAWS.bend": "import Base\n" });
  assert.equal(proof.diagnostics.length, 1);
  assert.equal(imported.slice(proof.diagnostics[0].range.start, proof.diagnostics[0].range.end), "./lib.bend");
  assert.match(proof.diagnostics[0].message, /Lib\.spin/);
});

test("requires PROOF.bend to import LAWS.bend", async () => {
  const result = await analyzeFiles("proof", { "PROOF.bend": "import Base\n\ndef zero() -> U32:\n  0\n", "LAWS.bend": "import Base\n" });
  assert.deepEqual(result.diagnostics.map((item) => item.message), ["PROOF.bend must import ./LAWS.bend."]);
});

test("describes local, imported and Base names", async () => {
  const main = "import Base\nimport ./dep.bend as Dep\n\n# The answer.\ndef main() -> U32:\n  Dep.Box.get(Dep.Box{Dep.answer})\n";
  const dep = "import Base\n\ntype Box is Data:\n  # Wraps a number.\n  Box{x: U32}\n\ndef Box.get(b: Box) -> U32:\n  match b:\n    case Box{x}:\n      x\n\ndef answer() -> U32:\n  42\n";
  const result = await analyzeFiles("names", { "main.bend": main, "dep.bend": dep });
  assert.deepEqual(result.diagnostics, []);
  assert.match(result.hovers.main, /The answer\./);
  assert.match(result.hovers["Dep.Box.get"], /Dep\.Box\.get : @b:Dep\.Box -> U32/);
  assert.match(result.hovers["Dep.Box"], /\*\*type Dep\.Box\*\*/);
  assert.match(result.hovers["Dep.Box{}"], /\*\*constructor Dep\.Box\*\*[\s\S]*Wraps a number\./);
  assert.equal(result.definitions.main.range.start.line, 4);
  assert.equal(result.definitions["Dep.Box"].range.start.line, 2);
  assert.equal(result.definitions["Dep.Box{}"].range.start.line, 4);
  assert.match(result.definitions["U32.show"].uri, /\/base\.bend$/);
  const labels = new Set(result.completions.map((item) => `${item.kind} ${item.label}`));
  for (const label of ["def main", "def Dep.answer", "type Dep.Box", "constructor Dep.Box", "def U32.show", "constructor True"]) assert.ok(labels.has(label), label);
  assert.equal(result.hovers.get, undefined);
});

test("replaces a worker stuck in a check that never returns", { timeout: 20_000 }, async () => {
  const analyzer = new Analyzer({ timeoutMs: 2_000 });
  const dir = path.join(os.tmpdir(), `bend2-lsp-stuck-${process.pid}`);
  const request = (name: string, text: string) => {
    const file = path.join(dir, name);
    const uri = pathToFileURL(file).href;
    return analyzer.analyze({ type: "analyze", uri, path: file, version: 1, text, overlays: [{ uri, path: file, version: 1, text }] });
  };
  try {
    const stuck = request("stuck.bend", "import Base\n\n@unsafe def spin(n: U32) -> U32:\n  spin(n)\n\nlaw loops:\n  {spin(1) == 0 : U32}\n\ndef loops():\n  {==}\n");
    const queued = request("fine.bend", "import Base\n\ndef main() -> U32:\n  0\n");
    assert.match((await stuck).diagnostics[0].message, /Checking stopped after 2 s/);
    assert.deepEqual((await queued).diagnostics, []);
  } finally {
    await analyzer.close();
  }
});
