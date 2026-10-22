# Bend 2 language server

`bend2-lsp` provides formatting, live compiler diagnostics, Markdown hover,
go-to-definition, completion, document symbols, and folding for Bend 2 over
LSP stdio. Node.js 26.9 or newer is required.

```sh
npm install -g bend2-lsp
bend2-lsp --stdio
```

To build from source, run `npm ci && npm test`.

The server accepts the `bend` and `bend2` language IDs. It uses full-document
sync, publishes diagnostics on open and 250 ms after edits, and rechecks open
documents that import a changed buffer. Open buffers override files on disk.
Compiler analysis is limited to `file:` documents; untitled documents still
receive formatting, lexical diagnostics, syntax hover, symbols, and folding.

Diagnostics report the compiler's first error, every `?TODO` hole, and every
law without a proof. They also follow the verdict of `bend --check-only`: a
def that is `@unsafe` or foreign, or relies on one through other defs or
imports, is no proof. In a file without `main` each such def is an error, as
`bend` reports `SOME PROOFS FAIL`; in a program only laws that rely on one are
flagged, as warnings. `PROOF.bend` must import the `LAWS.bend` beside it.

Hover shows the checked type of top-level names, constructors, Base, and
imported declarations, as the file spells them (`Dep.answer`), with the `#`
comment lines directly above the declaration. Go-to-definition resolves import
paths and aliases, and names declared in the file, its relative imports, and
Base (which opens the bundled `base.bend`). Completion offers keywords and every
name in scope from the last analysis, including alias-qualified names after
`.`. Document symbols list types with their constructors, defs, and laws.

Analysis uses the bundled Bend compiler and Base library in a worker thread.
Relative imports resolve from the document, then from open overlays. Hub
package imports (`0x<hash>/` and `<name>@<version>/`) use `BEND_LIB`; missing
packages may be downloaded from `BEND_HUB`, checked by the compiler, and cached
in the normal package layout. Downloads time out after 10 seconds. A check that
answers nothing for 30 seconds, such as one evaluating an `@unsafe` def that
never returns, is stopped with a diagnostic and the worker is replaced.

The formatter preserves line breaks, blank lines, comments, literal spelling,
each line ending, and final-newline state. It normalizes indentation and safe
token spacing without wrapping code, and keeps lines pinned to a body's column
where Bend's layout depends on it.

## Editor setup

VS Code:

Install the [Bend 2 extension](https://marketplace.visualstudio.com/items?itemName=kbrianps.bend2) (`kbrianps.bend2`, also on [Open VSX](https://open-vsx.org/extension/kbrianps/bend2)), which bundles `bend2-lsp` and provides syntax highlighting, live diagnostics, hover, and formatting out of the box.

To point the extension at a custom or local server build, set `bend.server.path` in `settings.json`:

```json
{
  "bend.server.path": "bend2-lsp"
}
```

Neovim with `nvim-lspconfig`:

```lua
vim.api.nvim_create_autocmd("FileType", {
  pattern = "bend",
  callback = function()
    vim.lsp.start({
      name = "bend2-lsp",
      cmd = { "bend2-lsp", "--stdio" },
      root_dir = vim.fs.root(0, { ".git" }),
    })
  end,
})
```

Helix (`languages.toml`):

```toml
[language-server.bend2-lsp]
command = "bend2-lsp"
args = ["--stdio"]

[[language]]
name = "bend"
scope = "source.bend"
file-types = ["bend"]
language-servers = ["bend2-lsp"]
auto-format = true
```

Emacs with Eglot:

```elisp
(add-to-list 'eglot-server-programs
             '(bend-mode . ("bend2-lsp" "--stdio")))
```

Local-variable type hover is intentionally out of scope because it would
require instrumentation in the trusted checker. Unknown names and inferred
locals therefore return no hover.

## Compiler source

`vendor/bend2/bend.ts` and `vendor/bend2/base.bend` are unmodified copies from
[`bendlang/bend` v2.0.38 (commit `0a57ca0`)](https://github.com/bendlang/bend/tree/0a57ca0d21de94a3724d8be21afb0eb89f88b4d8/bend2).
They are bundled into the npm package so installation does not require a Bend
checkout. `src/formatter.ts` and its tests follow `tools/bend-fmt-lsp` at the
same commit, and the verdict check ports `book_promises` from `bend2/main.ts`.
The compiler and this language server are licensed under Apache 2.0; see
`LICENSE`. Update both vendored files together from a pinned Bend release tag,
check that `git hash-object` matches the upstream blobs, then run `npm test`
and inspect `npm pack --dry-run` before releasing.

Two formatter tests run programs before and after formatting. They are skipped
unless `BEND2_LSP_TEST_BEND` names a `bend` command, ideally of the vendored
version.
