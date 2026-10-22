export type OffsetRange = { start: number; end: number };
export type Location = { uri: string; range: { start: { line: number; character: number }; end: { line: number; character: number } } };

export type AnalysisDiagnostic = {
  uri: string;
  range: OffsetRange;
  message: string;
  code: "parsing" | "checking" | "imports" | "incomplete-law" | "holes" | "verdict";
  severity?: "error" | "warning";
};

export type CompletionEntry = { label: string; kind: "def" | "law" | "type" | "constructor"; detail: string; documentation?: string };

// Hovers and definitions are keyed by a name as the analyzed file spells it.
// A constructor that shares its type's name is also keyed as `Name{}`.
export type AnalysisResult = {
  id: number;
  uri: string;
  version: number;
  versions: Record<string, number>;
  diagnostics: AnalysisDiagnostic[];
  hovers: Record<string, string>;
  definitions: Record<string, Location>;
  completions: CompletionEntry[];
};

export type Overlay = { uri: string; path: string; version: number; text: string };
export type AnalysisRequest = {
  type: "analyze";
  id: number;
  uri: string;
  path: string;
  version: number;
  text: string;
  overlays: Overlay[];
};
