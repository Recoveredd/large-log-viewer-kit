# large-log-viewer-kit

[![npm version](https://img.shields.io/npm/v/large-log-viewer-kit.svg)](https://www.npmjs.com/package/large-log-viewer-kit)
[![License: MPL-2.0](https://img.shields.io/badge/license-MPL--2.0-blue.svg)](LICENSE)
[![CI](https://github.com/Recoveredd/large-log-viewer-kit/actions/workflows/ci.yml/badge.svg)](https://github.com/Recoveredd/large-log-viewer-kit/actions/workflows/ci.yml)

Inspect and render large browser logs with offset indexing, virtual windows, chunked search and safe ANSI-aware HTML helpers.

`large-log-viewer-kit` is a small clean-room toolkit for building log viewers without rendering every line in the DOM. It is framework-agnostic, browser-friendly, ESM-only and has no runtime dependencies.

Links: [Demo](https://packages.wasta-wocket.fr/large-log-viewer-kit/) · [npm](https://www.npmjs.com/package/large-log-viewer-kit) · [GitHub](https://github.com/Recoveredd/large-log-viewer-kit)

## Package quality

- TypeScript types are generated from the source.
- ESM-only package with no runtime dependencies.
- Marked as side-effect free for bundlers.
- Browser-friendly implementation with no Node-only APIs.
- CI runs `npm ci`, `typecheck`, `build`, and `test`.
- Tested on Node.js 20 and 22 with GitHub Actions.

## Install

```bash
npm install large-log-viewer-kit
```

## Quick Start

```ts
import { createLogDocument } from "large-log-viewer-kit";

const log = createLogDocument(bigLogText);

const window = log.getWindow({
  scrollTop: 12_000,
  viewportHeight: 480,
  rowHeight: 20,
  overscan: 8
});

for (const row of window.rows) {
  console.log(row.lineNumber, row.text);
}
```

## Why This Package

Large logs get slow when a viewer does naive work:

- `text.split("\n")` creates a large array and duplicates pressure on memory;
- rendering every line creates too many DOM nodes;
- searching the whole file in one synchronous pass blocks the UI;
- ANSI color parsing is wasted work for lines the user cannot see.

This package keeps the core small:

- line indexing stores offsets instead of an array of line strings;
- virtual windows return only the visible rows plus overscan;
- search sessions advance by chunks, so UI code can yield between steps;
- ANSI parsing and HTML escaping can be applied only to visible lines.

## Create a Log Document

```ts
import { createLogDocument } from "large-log-viewer-kit";

const document = createLogDocument("INFO boot\nWARN disk\nINFO ready\n");

document.lineCount;
// 3

document.getLine(2);
// {
//   lineNumber: 2,
//   text: "WARN disk",
//   startOffset: 10,
//   endOffset: 19,
//   hasNewline: true
// }
```

Line numbers are 1-based because that is what users expect in a log viewer.
Offsets are JavaScript string offsets, not byte offsets. If you decode a `Blob` or `Response` before creating the document, the offsets refer to the decoded string.

LF, CRLF and CR-only line endings are indexed. Mixed newline styles are reported through diagnostics.

By default, a trailing newline does not create a final empty line. Enable it when your UI needs to show that final blank row:

```ts
createLogDocument("one\n", { keepTrailingEmptyLine: true }).lineCount;
// 2
```

## Virtualize Rows

```ts
const window = document.getWindow({
  scrollTop: 20 * 500,
  viewportHeight: 20 * 12,
  rowHeight: 20,
  overscan: 4
});

window.totalHeight;
// Use this as the height of the inner spacer.

window.offsetTop;
// Use this to translate the rendered rows.

window.rows;
// Only the visible rows plus overscan.
```

The package does not own your DOM. In React, Vue, Svelte or plain JavaScript, keep scroll state in your app and ask the document for the current window.

## Chunked Search

```ts
const search = document.createSearch("error", {
  caseSensitive: false,
  maxResults: 500,
  includeLineText: true
});

while (!search.done) {
  const step = search.next(2_000);

  // In a browser UI, call the next chunk from requestIdleCallback,
  // setTimeout, a worker message, or your framework scheduler.
  console.log(step.searchedLineCount, step.resultCount);
}

search.results[0];
// {
//   lineNumber: 42,
//   columnStart: 12,
//   columnEnd: 17,
//   startOffset: 912,
//   endOffset: 917,
//   lineText: "..."
// }
```

Use `includeLineText: false` when you only need positions and want to keep result objects smaller.

## ANSI and Safe HTML

```ts
import { renderLogLineHtml, stripAnsi } from "large-log-viewer-kit";

stripAnsi("\x1b[31mERROR\x1b[0m");
// "ERROR"

renderLogLineHtml("\x1b[31mERROR\x1b[0m <unsafe>", {
  ansi: true,
  highlightQuery: "error"
});
// '<span class="llv-fg-red"><mark class="llv-match">ERROR</mark></span> &lt;unsafe&gt;'
```

The HTML helper escapes user content. ANSI styles are emitted as CSS classes so your app controls the visual theme.

Common class names:

- `llv-bold`, `llv-italic`, `llv-underline`;
- `llv-fg-red`, `llv-fg-bright-yellow`;
- `llv-bg-blue`, `llv-bg-bright-black`;
- `llv-fg-ansi-196`, `llv-bg-ansi-236` for 256-color ANSI codes;
- `llv-match`.

Truecolor ANSI values are emitted as safe numeric inline `rgb(...)` styles.

Use `classPrefix` if your app needs different class names.

## API

### `createLogDocument(source, options?)`

Creates an indexed document over a string.

```ts
type CreateLogDocumentOptions = {
  keepTrailingEmptyLine?: boolean;
};
```

The returned document exposes:

```ts
type LogDocument = {
  source: string;
  length: number;
  lineCount: number;
  diagnostics: LogDocumentDiagnostic[];
  getLine(lineNumber: number): LogLine | undefined;
  getLines(startLine: number, count: number): LogLine[];
  getWindow(request: VirtualLogWindowRequest): VirtualLogWindow;
  createSearch(query: string, options?: LogSearchOptions): LogSearchSession;
};
```

### `getVirtualLogWindow(document, request)`

Standalone helper used internally by `document.getWindow()`. Use it when you have your own document-like adapter.

### `createLogSearchSession(document, query, options?)`

Creates a search session that advances with `next(chunkLineCount?)`.

```ts
type LogSearchOptions = {
  caseSensitive?: boolean;
  maxResults?: number;
  startLine?: number;
  endLine?: number;
  includeLineText?: boolean;
};
```

### `parseAnsiLine(input)`

Parses common SGR ANSI escape codes into text segments and style metadata.

### `stripAnsi(input)`

Removes common SGR ANSI escape codes.

### `renderLogLineHtml(input, options?)`

Escapes a visible line and optionally applies ANSI class spans and query highlights.

## Performance Notes

This package is designed for large logs that are already available as text in memory. It avoids the worst viewer mistakes, but it does not make browser memory limits disappear.

Good fit for v0.1:

- logs from a `File`, `Blob`, fetch response or generated text once decoded;
- tens of thousands to millions of lines when the UI renders a virtual window;
- search that can be scheduled in chunks;
- browser demos, dashboards and developer tools.

Out of scope for v0.1:

- multi-GB logs that cannot fit in memory after decoding;
- remote byte-range loading;
- full terminal emulation;
- semantic log parsing for a specific backend;
- regex search and worker orchestration built into the package.

For very large files, pair this package with your own `File`/`Blob` loading strategy and run chunked search from a worker or idle callback.

## Diagnostics

Document diagnostics are stable strings:

- `empty-log`;
- `trailing-newline`;
- `contains-crlf`;
- `contains-cr-only`;
- `mixed-newlines`.

They are meant for UI hints and tests, not for throwing.

## License

MPL-2.0
