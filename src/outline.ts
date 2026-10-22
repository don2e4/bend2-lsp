// Declarations and folding read from the text alone, so they work on buffers
// the compiler rejects.

export type Declaration = {
  kind: "def" | "law" | "type" | "constructor";
  name: string;
  start: number;
  end: number;
  detail: string;
  doc: string;
  blockEnd: number;
  parent?: number;
};

export type Fold = { startLine: number; endLine: number; kind?: "comment" | "imports" };

const HEADER = /^([ \t]*)(?:@unsafe[ \t]+)?(def|law|type)[ \t]+([A-Za-z_][A-Za-z0-9_.]*)/;
const CONSTRUCTOR = /^([ \t]+)([A-Za-z_][A-Za-z0-9_.]*)[ \t]*\{/;

type Line = { text: string; at: number; code: string };

function lines(text: string): Line[] {
  const result: Line[] = [];
  let at = 0;
  for (const raw of text.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    result.push({ text: line, at, code: stripComment(line).trimEnd() });
    at += raw.length + 1;
  }
  return result;
}

function stripComment(line: string): string {
  let quote = "";
  let escaped = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
    } else if (char === '"' || char === "'") quote = char;
    else if (char === "#") return line.slice(0, i);
  }
  return line;
}

function indent(line: Line): number {
  return line.text.length - line.text.trimStart().length;
}

function docAbove(all: Line[], index: number): string {
  const doc: string[] = [];
  for (let i = index - 1; i >= 0 && all[i].code === "" && all[i].text.trim().startsWith("#"); i--) {
    doc.unshift(all[i].text.trim().replace(/^#[ \t]?/, ""));
  }
  return doc.join("\n");
}

export function declarations(text: string): Declaration[] {
  const all = lines(text);
  const found: Declaration[] = [];
  let type: number | undefined;
  let current: number | undefined;
  let lastCode = 0;
  const close = () => {
    if (current !== undefined) found[current].blockEnd = all[lastCode].at + all[lastCode].code.length;
  };
  for (const [index, line] of all.entries()) {
    if (line.code.trim() === "") continue;
    const header = HEADER.exec(line.code);
    const nested = indent(line) > 0;
    if (header) {
      close();
      current = found.length;
      const start = line.at + header[0].length - header[3].length;
      found.push({
        kind: header[2] as Declaration["kind"], name: header[3], start, end: start + header[3].length,
        detail: line.code.slice(header[0].length).trim().replace(/:$/, "").trim(), doc: docAbove(all, index), blockEnd: -1,
      });
      type = header[2] === "type" ? found.length - 1 : undefined;
    } else if (!nested) {
      type = undefined;
    } else if (type !== undefined) {
      const constructor = CONSTRUCTOR.exec(line.code);
      if (constructor) {
        const start = line.at + constructor[1].length;
        found.push({
          kind: "constructor", name: constructor[2], start, end: start + constructor[2].length,
          detail: line.code.trim(), doc: docAbove(all, index), blockEnd: line.at + line.code.length, parent: type,
        });
      }
    }
    lastCode = index;
  }
  close();
  return found;
}

export function foldingRanges(text: string): Fold[] {
  const all = lines(text);
  const folds: Fold[] = [];
  const open: Array<{ line: number; width: number }> = [];
  let lastCode = -1;
  let comments = -1;
  let imports = -1;
  const flush = (kind: "comment" | "imports", from: number, to: number) => {
    if (from >= 0 && to > from) folds.push({ startLine: from, endLine: to, kind });
  };
  for (const [index, line] of all.entries()) {
    const comment = line.code.trim() === "" && line.text.trim().startsWith("#");
    if (comment) {
      if (comments < 0) comments = index;
      continue;
    }
    if (comments >= 0) flush("comment", comments, index - 1);
    comments = -1;
    if (line.code.trim() === "") continue;
    const isImport = /^import(?:\s|$)/.test(line.code.trim()) && indent(line) === 0;
    if (isImport && imports < 0) imports = index;
    if (!isImport && imports >= 0) {
      flush("imports", imports, lastCode);
      imports = -2;
    }
    const width = indent(line);
    while (open.length && open.at(-1)!.width >= width) {
      const block = open.pop()!;
      if (lastCode > block.line) folds.push({ startLine: block.line, endLine: lastCode });
    }
    open.push({ line: index, width });
    lastCode = index;
  }
  if (comments >= 0) flush("comment", comments, all.length - 1);
  if (imports >= 0) flush("imports", imports, lastCode);
  for (const block of open) if (lastCode > block.line) folds.push({ startLine: block.line, endLine: lastCode });
  return folds.sort((a, b) => a.startLine - b.startLine || b.endLine - a.endLine);
}
