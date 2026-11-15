export type OffsetRange = { start: number; end: number };
export type Location = { uri: string; range: { start: { line: number; character: number }; end: { line: number; character: number } } };

export type AnalysisDiagnostic = {
  uri: string;
  range: OffsetRange;
  message: string;
  code: "parsing" | "checking" | "imports" | "incomplete-law" | "holes" | "verdict" | "proof-context";
  severity?: "error" | "warning";
};

export type CompletionEntry = { label: string; kind: "def" | "law" | "type" | "constructor"; detail: string; documentation?: string };

// One top-level name: where it is declared and used. Ranges cover the name
// without an import alias, so a rename rewrites each the same way.
export type Reference = { declarations: Location[]; uses: Location[]; renameable: boolean };

// Hovers and definitions are keyed by a name as the analyzed file spells it.
// A constructor that shares its type's name is also keyed as `Name{}`.
export type AnalysisResult = {
  id: number;
  uri: string;
  version: number;
  versions: Record<string, number>;
  // Includes closed files and missing conventional entrypoint candidates.
  dependencies?: string[];
  entrypoint?: string;
  diagnostics: AnalysisDiagnostic[];
  hovers: Record<string, string>;
  definitions: Record<string, Location>;
  completions: CompletionEntry[];
  // Empty when the files did not parse, so a rename never works from part of them.
  references: Reference[];
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
  workspaceRoot?: string;
  // Relative to workspaceRoot. false opts out of conventional discovery.
  proofEntrypoint?: string | false;
};
