import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

type Message = { id?: number; method?: string; params?: unknown; result?: unknown; error?: unknown };
type Published = { uri: string; version?: number; diagnostics: Array<{ code?: string; message: string }> };
type WaitFor = ((id: number) => Promise<Message>) & { notification(method: string): Promise<Message>; diagnostics: Map<string, Published> };

function send(child: ChildProcessWithoutNullStreams, message: object): void {
  const body = JSON.stringify(message);
  child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

function responses(child: ChildProcessWithoutNullStreams): WaitFor {
  let buffer = Buffer.alloc(0);
  let stderr = "";
  const pending = new Map<number, { resolve: (message: Message) => void; reject: (error: Error) => void }>();
  const notificationPending = new Map<string, { resolve: (message: Message) => void; reject: (error: Error) => void }>();
  const notificationQueued = new Map<string, Message[]>();
  const diagnostics = new Map<string, Published>();
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  child.on("exit", (code) => {
    const error = new Error(`server exited (${code}): ${stderr.trim()}`);
    for (const waiter of [...pending.values(), ...notificationPending.values()]) waiter.reject(error);
    pending.clear();
    notificationPending.clear();
  });
  child.stdout.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const marker = buffer.indexOf("\r\n\r\n");
      if (marker < 0) return;
      const header = buffer.subarray(0, marker).toString("ascii");
      const length = Number(/Content-Length: (\d+)/i.exec(header)?.[1]);
      if (!Number.isFinite(length) || buffer.length < marker + 4 + length) return;
      const message = JSON.parse(buffer.subarray(marker + 4, marker + 4 + length).toString("utf8")) as Message;
      buffer = buffer.subarray(marker + 4 + length);
      if (message.id !== undefined) pending.get(message.id)?.resolve(message);
      else if (message.method) {
        if (message.method === "textDocument/publishDiagnostics") {
          const published = message.params as Published;
          diagnostics.set(published.uri, published);
        }
        const waiter = notificationPending.get(message.method);
        if (waiter) {
          notificationPending.delete(message.method);
          waiter.resolve(message);
        } else notificationQueued.set(message.method, [...(notificationQueued.get(message.method) ?? []), message]);
      }
    }
  });
  const waitFor = ((id: number) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for response ${id}`)), 5000);
    pending.set(id, { resolve: (message) => {
      clearTimeout(timer);
      pending.delete(id);
      resolve(message);
    }, reject: (error) => { clearTimeout(timer); reject(error); } });
  })) as WaitFor;
  waitFor.notification = (method) => new Promise((resolve, reject) => {
    const queued = notificationQueued.get(method)?.shift();
    if (queued) { resolve(queued); return; }
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${method}`)), 5000);
    notificationPending.set(method, { resolve: (message) => { clearTimeout(timer); resolve(message); }, reject: (error) => { clearTimeout(timer); reject(error); } });
  });
  waitFor.diagnostics = diagnostics;
  return waitFor;
}

test("refreshes contextual diagnostics for closed files and unsaved proof edits", async (context) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bend2-context-session-"));
  const lawPath = path.join(dir, "LAWS.bend");
  const proofPath = path.join(dir, "PROOF.bend");
  const lawUri = pathToFileURL(lawPath).href;
  const proofUri = pathToFileURL(proofPath).href;
  const laws = "import Base\n\nlaw same:\n  {0 == 0 : U32}\n";
  const missing = "import ./LAWS.bend as L\n";
  const good = missing + "\ndef L.same(): {==}\n";
  const broken = missing + "\ndef L.same(): 42\n";
  fs.writeFileSync(lawPath, laws);
  fs.writeFileSync(proofPath, good);
  const server = process.env.BEND2_LSP_SERVER ?? fileURLToPath(new URL("../server.js", import.meta.url));
  const child = spawn(process.execPath, [server, "--stdio"], { stdio: ["pipe", "pipe", "pipe"] });
  context.after(() => { child.kill(); fs.rmSync(dir, { recursive: true, force: true }); });
  const waitFor = responses(child);
  let id = 1;
  const call = async (method: string, params: object) => {
    const reply = waitFor(id);
    send(child, { jsonrpc: "2.0", id: id++, method, params });
    const message = await reply;
    assert.equal(message.error, undefined);
    return message.result;
  };
  const until = async (predicate: () => boolean | Promise<boolean>) => {
    for (let tries = 0; tries < 200; tries++) {
      if (await predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.fail(`timed out: ${JSON.stringify([...waitFor.diagnostics])}`);
  };
  const has = (uri: string, code: string) => !!waitFor.diagnostics.get(uri)?.diagnostics.some((item) => item.code === code);
  const checked = async () => {
    await until(async () => !!await call("textDocument/hover", { textDocument: { uri: lawUri }, position: { line: 2, character: 5 } }));
    assert.deepEqual(waitFor.diagnostics.get(lawUri)?.diagnostics, []);
  };
  await call("initialize", { rootUri: pathToFileURL(dir).href, capabilities: {} });
  send(child, { jsonrpc: "2.0", method: "initialized", params: {} });
  send(child, { jsonrpc: "2.0", method: "textDocument/didOpen", params: { textDocument: { uri: lawUri, languageId: "bend", version: 1, text: laws } } });
  await checked();

  // This independent root imports the laws but not their proofs. Its standalone
  // incomplete-law diagnostics must not contaminate the laws' proof context.
  const scratchUri = pathToFileURL(path.join(dir, "scratch.bend")).href;
  const scratch = "import ./LAWS.bend as L\n\ndef helper() -> U32:\n  0\n";
  send(child, { jsonrpc: "2.0", method: "textDocument/didOpen", params: { textDocument: { uri: scratchUri, languageId: "bend", version: 1, text: scratch } } });
  await until(async () => !!await call("textDocument/hover", { textDocument: { uri: scratchUri }, position: { line: 2, character: 5 } }));
  assert.deepEqual(waitFor.diagnostics.get(lawUri)?.diagnostics, []);
  send(child, { jsonrpc: "2.0", method: "textDocument/didClose", params: { textDocument: { uri: scratchUri } } });

  // Proof stays closed: a disk edit must invalidate and recheck the laws.
  fs.writeFileSync(proofPath, missing);
  await until(() => has(lawUri, "incomplete-law"));
  fs.writeFileSync(proofPath, broken);
  await until(() => has(lawUri, "proof-context") && !has(lawUri, "incomplete-law"));

  // Opening an unsaved repaired proof overrides its broken on-disk version.
  send(child, { jsonrpc: "2.0", method: "textDocument/didOpen", params: { textDocument: { uri: proofUri, languageId: "bend", version: 1, text: good } } });
  await checked();
  send(child, { jsonrpc: "2.0", method: "textDocument/didChange", params: { textDocument: { uri: proofUri, version: 2 }, contentChanges: [{ text: missing }] } });
  await until(() => has(lawUri, "incomplete-law"));
  send(child, { jsonrpc: "2.0", method: "textDocument/didChange", params: { textDocument: { uri: proofUri, version: 3 }, contentChanges: [{ text: good }] } });
  await checked();
  send(child, { jsonrpc: "2.0", method: "textDocument/didClose", params: { textDocument: { uri: proofUri } } });
  await until(() => has(lawUri, "proof-context"));
  fs.unlinkSync(proofPath);
  await until(() => has(lawUri, "incomplete-law"));
  fs.writeFileSync(proofPath, good);
  // Wait for the watcher to invalidate the missing-proof result first.
  await until(() => !has(lawUri, "incomplete-law"));
  await checked();
  assert.equal(await call("shutdown", {}), null);
  send(child, { jsonrpc: "2.0", method: "exit" });
});

test("serves formatting over an LSP stdio session", async (context) => {
  const server = process.env.BEND2_LSP_SERVER ?? fileURLToPath(new URL("../server.js", import.meta.url));
  const child = spawn(process.execPath, [server, "--stdio"], { stdio: ["pipe", "pipe", "pipe"] });
  context.after(() => child.kill());
  const waitFor = responses(child);

  const initialized = waitFor(1);
  send(child, { jsonrpc: "2.0", id: 1, method: "initialize", params: { capabilities: {} } });
  const initialize = await initialized;
  assert.equal(initialize.error, undefined);
  assert.deepEqual((initialize.result as { capabilities: object }).capabilities, {
    textDocumentSync: 1,
    documentFormattingProvider: true,
    hoverProvider: true,
    definitionProvider: true,
    completionProvider: { triggerCharacters: ["."] },
    documentSymbolProvider: true,
    foldingRangeProvider: true,
  });

  send(child, { jsonrpc: "2.0", method: "initialized", params: {} });
  const diagnostics = waitFor.notification("textDocument/publishDiagnostics");
  send(child, {
    jsonrpc: "2.0",
    method: "textDocument/didOpen",
    params: { textDocument: { uri: "file:///main.bend", languageId: "bend", version: 1, text: "def main()->U32:\n    0" } },
  });
  const formatted = waitFor(2);
  send(child, {
    jsonrpc: "2.0",
    id: 2,
    method: "textDocument/formatting",
    params: { textDocument: { uri: "file:///main.bend" }, options: { tabSize: 2, insertSpaces: true } },
  });
  assert.deepEqual((await formatted).result, [{
    range: { start: { line: 0, character: 0 }, end: { line: 1, character: 5 } },
    newText: "def main() -> U32:\n  0",
  }]);
  const published = (await diagnostics).params as { uri: string; diagnostics: Array<{ source: string }> };
  assert.equal(published.uri, "file:///main.bend");
  assert.ok(published.diagnostics.every((item) => item.source === "bend2"));

  const hovered = waitFor(4);
  send(child, { jsonrpc: "2.0", id: 4, method: "textDocument/hover", params: { textDocument: { uri: "file:///main.bend" }, position: { line: 0, character: 1 } } });
  assert.match(JSON.stringify((await hovered).result), /Declares a top-level function/);

  const changed = waitFor.notification("textDocument/publishDiagnostics");
  send(child, { jsonrpc: "2.0", method: "textDocument/didChange", params: { textDocument: { uri: "file:///main.bend", version: 2 }, contentChanges: [{ text: "def main() -> U32:\n  ?TODO" }] } });
  send(child, { jsonrpc: "2.0", method: "textDocument/didChange", params: { textDocument: { uri: "file:///main.bend", version: 3 }, contentChanges: [{ text: "def main() -> U32:\n  0" }] } });
  let update = await changed;
  while (((update.params as { version: number }).version) < 3) update = await waitFor.notification("textDocument/publishDiagnostics");
  assert.equal((update.params as { version: number }).version, 3);

  const cleared = waitFor.notification("textDocument/publishDiagnostics");
  send(child, { jsonrpc: "2.0", method: "textDocument/didClose", params: { textDocument: { uri: "file:///main.bend" } } });
  let closeUpdate = await cleared;
  while ((closeUpdate.params as { version?: number }).version !== undefined) closeUpdate = await waitFor.notification("textDocument/publishDiagnostics");
  assert.deepEqual((closeUpdate.params as { diagnostics: unknown[] }).diagnostics, []);

  const shutdown = waitFor(3);
  send(child, { jsonrpc: "2.0", id: 3, method: "shutdown" });
  assert.equal((await shutdown).result, null);
  send(child, { jsonrpc: "2.0", method: "exit" });
});

test("navigates imports and clears diagnostics after an imported buffer is fixed", async (context) => {
  const server = process.env.BEND2_LSP_SERVER ?? fileURLToPath(new URL("../server.js", import.meta.url));
  const child = spawn(process.execPath, [server, "--stdio"], { stdio: ["pipe", "pipe", "pipe"] });
  context.after(() => child.kill());
  const waitFor = responses(child);
  const dir = path.join(os.tmpdir(), `bend2-lsp-session-${process.pid}`);
  const mainUri = pathToFileURL(path.join(dir, "main.bend")).href;
  const depUri = pathToFileURL(path.join(dir, "dep.bend")).href;
  const mainText = "import ./dep.bend as Dep\n\ndef main() -> U32:\n  Dep.answer # Dep.answer";
  const bad = 'import Base\n\ndef answer() -> U32:\n  "no"';
  const good = "import Base\n\ndef answer() -> U32:\n  42";
  type Published = { uri: string; version?: number; diagnostics: unknown[] };
  const queued: Published[] = [];
  const diagnostics = async (uri: string, version: number, accept = (_items: unknown[]) => true) => {
    const matches = (item: Published) => item.uri === uri && item.version === version && accept(item.diagnostics);
    while (true) {
      const index = queued.findIndex(matches);
      if (index >= 0) return queued.splice(index, 1)[0].diagnostics;
      const message = (await waitFor.notification("textDocument/publishDiagnostics")).params as Published;
      if (matches(message)) return message.diagnostics;
      queued.push(message);
    }
  };

  const initialized = waitFor(1);
  send(child, { jsonrpc: "2.0", id: 1, method: "initialize", params: { capabilities: {} } });
  assert.equal((await initialized).error, undefined);
  send(child, { jsonrpc: "2.0", method: "initialized", params: {} });
  send(child, { jsonrpc: "2.0", method: "textDocument/didOpen", params: { textDocument: { uri: depUri, languageId: "bend", version: 1, text: bad } } });
  send(child, { jsonrpc: "2.0", method: "textDocument/didOpen", params: { textDocument: { uri: mainUri, languageId: "bend", version: 1, text: mainText } } });
  assert.notEqual((await diagnostics(depUri, 1, (items) => items.length > 0)).length, 0);
  let location: unknown = null;
  for (let id = 2; id < 42 && !location; id++) {
    const definition = waitFor(id);
    send(child, { jsonrpc: "2.0", id, method: "textDocument/definition", params: { textDocument: { uri: mainUri }, position: { line: 3, character: 7 } } });
    location = (await definition).result;
    if (!location) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.deepEqual(location, { uri: depUri, range: { start: { line: 2, character: 4 }, end: { line: 2, character: 10 } } });

  const pathDefinition = waitFor(100);
  send(child, { jsonrpc: "2.0", id: 100, method: "textDocument/definition", params: { textDocument: { uri: mainUri }, position: { line: 0, character: 10 } } });
  assert.equal(((await pathDefinition).result as { uri: string }).uri, depUri);

  const aliasDefinition = waitFor(101);
  send(child, { jsonrpc: "2.0", id: 101, method: "textDocument/definition", params: { textDocument: { uri: mainUri }, position: { line: 0, character: 22 } } });
  assert.equal(((await aliasDefinition).result as { uri: string }).uri, depUri);

  const commentDefinition = waitFor(102);
  send(child, { jsonrpc: "2.0", id: 102, method: "textDocument/definition", params: { textDocument: { uri: mainUri }, position: { line: 3, character: 17 } } });
  assert.equal((await commentDefinition).result, null);

  send(child, { jsonrpc: "2.0", method: "textDocument/didChange", params: { textDocument: { uri: depUri, version: 2 }, contentChanges: [{ text: good }] } });
  assert.deepEqual(await diagnostics(depUri, 2), []);

  const invalidated = waitFor(103);
  send(child, { jsonrpc: "2.0", id: 103, method: "textDocument/definition", params: { textDocument: { uri: mainUri }, position: { line: 3, character: 7 } } });
  assert.equal((await invalidated).result, null);
  let restored: unknown = null;
  for (let id = 104; id < 144 && !restored; id++) {
    const definition = waitFor(id);
    send(child, { jsonrpc: "2.0", id, method: "textDocument/definition", params: { textDocument: { uri: mainUri }, position: { line: 3, character: 7 } } });
    restored = (await definition).result;
    if (!restored) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.deepEqual(restored, location);

  const shutdown = waitFor(200);
  send(child, { jsonrpc: "2.0", id: 200, method: "shutdown" });
  assert.equal((await shutdown).result, null);
  send(child, { jsonrpc: "2.0", method: "exit" });
});

test("completes, outlines and folds over an LSP session", async (context) => {
  const server = process.env.BEND2_LSP_SERVER ?? fileURLToPath(new URL("../server.js", import.meta.url));
  const child = spawn(process.execPath, [server, "--stdio"], { stdio: ["pipe", "pipe", "pipe"] });
  context.after(() => child.kill());
  const waitFor = responses(child);
  const dir = path.join(os.tmpdir(), `bend2-lsp-features-${process.pid}`);
  const mainUri = pathToFileURL(path.join(dir, "main.bend")).href;
  const depUri = pathToFileURL(path.join(dir, "dep.bend")).href;
  const mainText = "import Base\nimport ./dep.bend as Dep\n\ndef main() -> U32:\n  Dep.Box.get(Dep.Box{Dep.answer})\n";
  const depText = "import Base\n\n# A box.\ntype Box is Data:\n  Box{x: U32}\n\ndef Box.get(b: Box) -> U32:\n  match b:\n    case Box{x}:\n      x\n\ndef answer() -> U32:\n  42\n";
  let id = 1;
  const call = async (method: string, params: object) => {
    const response = waitFor(id);
    send(child, { jsonrpc: "2.0", id, method, params });
    id++;
    return (await response).result;
  };

  await call("initialize", { capabilities: {} });
  send(child, { jsonrpc: "2.0", method: "initialized", params: {} });
  send(child, { jsonrpc: "2.0", method: "textDocument/didOpen", params: { textDocument: { uri: depUri, languageId: "bend", version: 1, text: depText } } });
  send(child, { jsonrpc: "2.0", method: "textDocument/didOpen", params: { textDocument: { uri: mainUri, languageId: "bend", version: 1, text: mainText } } });
  const hover = async (character: number) => JSON.stringify(await call("textDocument/hover", { textDocument: { uri: mainUri }, position: { line: 4, character } }));
  let constructor = "null";
  for (let tries = 0; tries < 40 && constructor === "null"; tries++) {
    constructor = await hover(16);
    if (constructor === "null") await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.match(constructor, /constructor Dep\.Box/);
  assert.match(await hover(6), /def Dep\.Box\.get/);

  const items = await call("textDocument/completion", { textDocument: { uri: mainUri }, position: { line: 4, character: 6 } }) as Array<{ label: string; textEdit: { range: unknown } }>;
  const answer = items.find((item) => item.label === "Dep.answer");
  assert.deepEqual(answer?.textEdit.range, { start: { line: 4, character: 2 }, end: { line: 4, character: 6 } });
  assert.ok(items.some((item) => item.label === "match"));

  const symbols = await call("textDocument/documentSymbol", { textDocument: { uri: depUri } }) as Array<{ name: string; children: Array<{ name: string }> }>;
  assert.deepEqual(symbols.map((symbol) => [symbol.name, symbol.children.map((child) => child.name)]), [["Box", ["Box"]], ["Box.get", []], ["answer", []]]);

  const folds = await call("textDocument/foldingRange", { textDocument: { uri: depUri } }) as Array<{ startLine: number; endLine: number }>;
  assert.ok(folds.some((fold) => fold.startLine === 6 && fold.endLine === 9));

  await call("shutdown", {});
  send(child, { jsonrpc: "2.0", method: "exit" });
});
