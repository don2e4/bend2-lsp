import assert from "node:assert/strict";
import test from "node:test";
import { declarations, foldingRanges } from "../outline.js";

const source = [
  "import Base",
  "import ./dep.bend as Dep",
  "",
  "# A shape.",
  "type Shape is Data:",
  "  # Round.",
  "  Circle{radius: U32}",
  "  Square{side: U32}",
  "",
  "# Its area.",
  "# Rounded down.",
  "def area(s: Shape) -> U32: # not a doc",
  "  match s:",
  "    case Circle{r}:",
  '      (3 * r * r : U32) # "#" in a comment',
  "    case Square{x}:",
  "      (x * x : U32)",
  "",
  "law area_zero:",
  "  {area(Square{0}) == 0 : U32}",
  "",
  "@unsafe def spin(n: U32) -> U32:",
  "  spin(n)",
  "",
].join("\n");

test("reads declarations, constructors and doc comments from text", () => {
  const found = declarations(source);
  assert.deepEqual(found.map((item) => [item.kind, item.name, item.parent]), [
    ["type", "Shape", undefined], ["constructor", "Circle", 0], ["constructor", "Square", 0],
    ["def", "area", undefined], ["law", "area_zero", undefined], ["def", "spin", undefined],
  ]);
  const [shape, circle, , area, , spin] = found;
  assert.equal(source.slice(shape.start, shape.end), "Shape");
  assert.equal(shape.doc, "A shape.");
  assert.equal(shape.detail, "is Data");
  assert.equal(circle.doc, "Round.");
  assert.equal(area.doc, "Its area.\nRounded down.");
  assert.equal(area.detail, "(s: Shape) -> U32");
  assert.equal(source.slice(area.start, area.blockEnd).split("\n").at(-1), "      (x * x : U32)");
  assert.equal(source.slice(shape.start, shape.blockEnd).split("\n").at(-1), "  Square{side: U32}");
  assert.equal(source.slice(spin.start, spin.end), "spin");
  assert.equal(source.slice(spin.start, spin.blockEnd).split("\n").at(-1), "  spin(n)");
});

test("folds imports, comment runs and indented blocks", () => {
  const folds = foldingRanges(source);
  assert.deepEqual(folds, [
    { startLine: 0, endLine: 1, kind: "imports" },
    { startLine: 4, endLine: 7 },
    { startLine: 9, endLine: 10, kind: "comment" },
    { startLine: 11, endLine: 16 },
    { startLine: 12, endLine: 16 },
    { startLine: 13, endLine: 14 },
    { startLine: 15, endLine: 16 },
    { startLine: 18, endLine: 19 },
    { startLine: 21, endLine: 22 },
  ]);
});

test("keeps CRLF offsets and ignores declarations inside comments and strings", () => {
  const crlf = "# def nope():\r\ndef yes() -> String:\r\n  \"def no\"\r\n";
  const [only, ...rest] = declarations(crlf);
  assert.equal(rest.length, 0);
  assert.equal(crlf.slice(only.start, only.end), "yes");
  assert.equal(only.doc, "def nope():");
});
