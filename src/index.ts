export type LogDocumentDiagnostic =
  | "empty-log"
  | "trailing-newline"
  | "contains-crlf"
  | "contains-cr-only"
  | "mixed-newlines";

export type CreateLogDocumentOptions = {
  keepTrailingEmptyLine?: boolean;
};

export type LogLine = {
  lineNumber: number;
  text: string;
  startOffset: number;
  endOffset: number;
  hasNewline: boolean;
};

export type LogDocument = {
  source: string;
  length: number;
  lineCount: number;
  diagnostics: LogDocumentDiagnostic[];
  getLine(lineNumber: number): LogLine | undefined;
  getLines(startLine: number, count: number): LogLine[];
  getWindow(request: VirtualLogWindowRequest): VirtualLogWindow;
  createSearch(query: string, options?: LogSearchOptions): LogSearchSession;
};

export type VirtualLogWindowRequest = {
  scrollTop: number;
  viewportHeight: number;
  rowHeight: number;
  overscan?: number;
};

export type VirtualLogWindow = {
  startLine: number;
  endLine: number;
  visibleStartLine: number;
  visibleEndLine: number;
  offsetTop: number;
  totalHeight: number;
  rows: LogLine[];
};

export type LogSearchOptions = {
  caseSensitive?: boolean;
  maxResults?: number;
  startLine?: number;
  endLine?: number;
  includeLineText?: boolean;
};

export type LogSearchMatch = {
  lineNumber: number;
  columnStart: number;
  columnEnd: number;
  startOffset: number;
  endOffset: number;
  lineText?: string;
};

export type LogSearchStep = {
  done: boolean;
  query: string;
  searchedLineCount: number;
  nextLine: number;
  resultCount: number;
  matches: LogSearchMatch[];
  results: LogSearchMatch[];
};

export type LogSearchSession = {
  query: string;
  done: boolean;
  searchedLineCount: number;
  resultCount: number;
  results: LogSearchMatch[];
  next(chunkLineCount?: number): LogSearchStep;
};

export type AnsiColor =
  | "black"
  | "red"
  | "green"
  | "yellow"
  | "blue"
  | "magenta"
  | "cyan"
  | "white"
  | "bright-black"
  | "bright-red"
  | "bright-green"
  | "bright-yellow"
  | "bright-blue"
  | "bright-magenta"
  | "bright-cyan"
  | "bright-white";

export type AnsiStyle = {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  color?: AnsiColor;
  backgroundColor?: AnsiColor;
  colorCode?: number;
  backgroundColorCode?: number;
  rgbColor?: readonly [number, number, number];
  rgbBackgroundColor?: readonly [number, number, number];
};

export type AnsiSegment = {
  text: string;
  style: AnsiStyle;
};

export type RenderLogLineHtmlOptions = {
  ansi?: boolean;
  classPrefix?: string;
  highlightQuery?: string;
  caseSensitiveHighlight?: boolean;
};

const ansiPattern = /\x1b\[([0-9;]*)m/g;
const defaultSearchChunkSize = 2_000;
const defaultMaxResults = 1_000;
const maxTypedOffset = 4_294_967_295;

const normalColors = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white"
] as const;

const brightColors = [
  "bright-black",
  "bright-red",
  "bright-green",
  "bright-yellow",
  "bright-blue",
  "bright-magenta",
  "bright-cyan",
  "bright-white"
] as const;

export function createLogDocument(
  source: string,
  options: CreateLogDocumentOptions = {}
): LogDocument {
  const diagnostics = collectDiagnostics(source);
  const lineStarts = indexLineStarts(source, options);

  return {
    source,
    length: source.length,
    lineCount: lineStarts.length,
    diagnostics,
    getLine(lineNumber) {
      return getLogLine(source, lineStarts, lineNumber);
    },
    getLines(startLine, count) {
      return getLogLines(source, lineStarts, startLine, count);
    },
    getWindow(request) {
      return getVirtualLogWindow(this, request);
    },
    createSearch(query, searchOptions) {
      return createLogSearchSession(this, query, searchOptions);
    }
  };
}

export function getVirtualLogWindow(
  document: Pick<LogDocument, "lineCount" | "getLines">,
  request: VirtualLogWindowRequest
): VirtualLogWindow {
  const rowHeight = Math.max(1, finiteOr(request.rowHeight, 1));
  const viewportHeight = Math.max(0, finiteOr(request.viewportHeight, 0));
  const scrollTop = Math.max(0, finiteOr(request.scrollTop, 0));
  const overscan = Math.max(0, Math.floor(finiteOr(request.overscan ?? 5, 5)));

  if (document.lineCount === 0) {
    return {
      startLine: 1,
      endLine: 0,
      visibleStartLine: 1,
      visibleEndLine: 0,
      offsetTop: 0,
      totalHeight: 0,
      rows: []
    };
  }

  const visibleStartLine = clamp(
    Math.floor(scrollTop / rowHeight) + 1,
    1,
    document.lineCount
  );
  const visibleCount = Math.max(1, Math.ceil(viewportHeight / rowHeight));
  const visibleEndLine = clamp(
    visibleStartLine + visibleCount - 1,
    visibleStartLine,
    document.lineCount
  );
  const startLine = clamp(visibleStartLine - overscan, 1, document.lineCount);
  const endLine = clamp(visibleEndLine + overscan, startLine, document.lineCount);

  return {
    startLine,
    endLine,
    visibleStartLine,
    visibleEndLine,
    offsetTop: (startLine - 1) * rowHeight,
    totalHeight: document.lineCount * rowHeight,
    rows: document.getLines(startLine, endLine - startLine + 1)
  };
}

export function getLogLineScrollTop(lineNumber: number, rowHeight: number): number {
  const safeLineNumber = Math.max(1, integerOr(lineNumber, 1));
  const safeRowHeight = Math.max(1, finiteOr(rowHeight, 1));
  return (safeLineNumber - 1) * safeRowHeight;
}

export function getLogLineAtScrollTop(
  scrollTop: number,
  rowHeight: number,
  lineCount?: number
): number {
  const safeScrollTop = Math.max(0, finiteOr(scrollTop, 0));
  const safeRowHeight = Math.max(1, finiteOr(rowHeight, 1));
  const lineNumber = Math.floor(safeScrollTop / safeRowHeight) + 1;

  if (lineCount === undefined) return lineNumber;
  return clamp(lineNumber, 1, Math.max(1, integerOr(lineCount, 1)));
}

export function createLogSearchSession(
  document: Pick<LogDocument, "lineCount" | "getLine">,
  query: string,
  options: LogSearchOptions = {}
): LogSearchSession {
  const normalizedQuery = options.caseSensitive ? query : query.toLowerCase();
  const startLine = clamp(integerOr(options.startLine, 1), 1, document.lineCount || 1);
  const endLine = clamp(
    integerOr(options.endLine, document.lineCount),
    startLine,
    document.lineCount || startLine
  );
  const maxResults = Math.max(0, integerOr(options.maxResults, defaultMaxResults));
  const results: LogSearchMatch[] = [];
  let nextLine = startLine;
  let searchedLineCount = 0;
  let done = query.length === 0 || document.lineCount === 0 || maxResults === 0;

  const session: LogSearchSession = {
    query,
    get done() {
      return done;
    },
    get searchedLineCount() {
      return searchedLineCount;
    },
    get resultCount() {
      return results.length;
    },
    results,
    next(chunkLineCount = defaultSearchChunkSize) {
      if (done) {
        return snapshotSearchStep(query, searchedLineCount, nextLine, results, [], true);
      }

      const chunkSize = Math.max(1, integerOr(chunkLineCount, defaultSearchChunkSize));
      const chunkEndLine = Math.min(endLine, nextLine + chunkSize - 1);
      const matches: LogSearchMatch[] = [];

      for (; nextLine <= chunkEndLine; nextLine += 1) {
        const line = document.getLine(nextLine);
        searchedLineCount += 1;
        if (!line) continue;

        const haystack = options.caseSensitive ? line.text : line.text.toLowerCase();
        let searchFrom = 0;

        while (results.length < maxResults) {
          const columnStart = haystack.indexOf(normalizedQuery, searchFrom);
          if (columnStart === -1) break;

          const columnEnd = columnStart + query.length;
          const match: LogSearchMatch = {
            lineNumber: line.lineNumber,
            columnStart,
            columnEnd,
            startOffset: line.startOffset + columnStart,
            endOffset: line.startOffset + columnEnd
          };
          if (options.includeLineText) match.lineText = line.text;
          results.push(match);
          matches.push(match);
          searchFrom = Math.max(columnEnd, columnStart + 1);
        }

        if (results.length >= maxResults) {
          done = true;
          break;
        }
      }

      if (nextLine > endLine) done = true;
      return snapshotSearchStep(query, searchedLineCount, nextLine, results, matches, done);
    }
  };

  return session;
}

export function parseAnsiLine(input: string): AnsiSegment[] {
  const segments: AnsiSegment[] = [];
  const currentStyle: AnsiStyle = {};
  let cursor = 0;

  for (const match of input.matchAll(ansiPattern)) {
    const start = match.index ?? 0;
    if (start > cursor) {
      segments.push({
        text: input.slice(cursor, start),
        style: { ...currentStyle }
      });
    }

    applyAnsiCodes(currentStyle, match[1] ?? "");
    cursor = start + match[0].length;
  }

  if (cursor < input.length) {
    segments.push({
      text: input.slice(cursor),
      style: { ...currentStyle }
    });
  }

  return segments.length > 0 ? segments : [{ text: input, style: {} }];
}

export function stripAnsi(input: string): string {
  return input.replace(ansiPattern, "");
}

export function renderLogLineHtml(
  input: string,
  options: RenderLogLineHtmlOptions = {}
): string {
  const classPrefix = options.classPrefix ?? "llv";
  const segments = options.ansi ? parseAnsiLine(input) : [{ text: input, style: {} }];

  return segments
    .map((segment) => {
      const content = renderHighlightedText(segment.text, options, classPrefix);
      const classes = ansiStyleToClasses(segment.style, classPrefix);
      const inlineStyle = ansiStyleToInlineStyle(segment.style);
      if (classes.length === 0 && inlineStyle.length === 0) return content;

      const attributes = [
        classes.length > 0 ? `class="${escapeHtml(classes.join(" "))}"` : "",
        inlineStyle.length > 0 ? `style="${inlineStyle}"` : ""
      ].filter(Boolean);

      return `<span ${attributes.join(" ")}>${content}</span>`;
    })
    .join("");
}

export function escapeHtml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function indexLineStarts(source: string, options: CreateLogDocumentOptions): Uint32Array {
  if (source.length === 0) return new Uint32Array(0);
  if (source.length > maxTypedOffset) {
    throw new RangeError("Log source is too large for Uint32Array-backed offsets.");
  }

  const lineStarts = [0];

  for (let index = 0; index < source.length; index += 1) {
    const charCode = source.charCodeAt(index);

    if (charCode === 13) {
      const hasLfPair = source.charCodeAt(index + 1) === 10;
      const nextStart = index + (hasLfPair ? 2 : 1);
      if (nextStart < source.length || options.keepTrailingEmptyLine) {
        lineStarts.push(nextStart);
      }
      if (hasLfPair) index += 1;
    } else if (charCode === 10) {
      const nextStart = index + 1;
      if (nextStart < source.length || options.keepTrailingEmptyLine) {
        lineStarts.push(nextStart);
      }
    }
  }

  return Uint32Array.from(lineStarts);
}

function getLogLine(
  source: string,
  lineStarts: ArrayLike<number>,
  lineNumber: number
): LogLine | undefined {
  const normalizedLineNumber = integerOr(lineNumber, 0);
  if (normalizedLineNumber < 1 || normalizedLineNumber > lineStarts.length) return undefined;

  const lineIndex = normalizedLineNumber - 1;
  const startOffset = lineStarts[lineIndex] ?? 0;
  const nextStart = lineStarts[lineIndex + 1];
  const hasNewline =
    nextStart !== undefined ||
    (startOffset < source.length && source.endsWith("\n")) ||
    (source.length > startOffset && source.endsWith("\r"));
  const endOffset = getContentEndOffset(source, startOffset, nextStart);

  return {
    lineNumber: normalizedLineNumber,
    text: source.slice(startOffset, endOffset),
    startOffset,
    endOffset,
    hasNewline
  };
}

function getContentEndOffset(
  source: string,
  startOffset: number,
  nextStart: number | undefined
): number {
  let endOffset = nextStart ?? source.length;

  if (endOffset > startOffset && source.charCodeAt(endOffset - 1) === 10) {
    endOffset -= 1;
  }

  if (endOffset > startOffset && source.charCodeAt(endOffset - 1) === 13) {
    endOffset -= 1;
  }

  return endOffset;
}

function getLogLines(
  source: string,
  lineStarts: ArrayLike<number>,
  startLine: number,
  count: number
): LogLine[] {
  if (!Number.isFinite(count) || count <= 0 || lineStarts.length === 0) return [];

  const normalizedStart = clamp(integerOr(startLine, 1), 1, lineStarts.length);
  const normalizedEnd = clamp(
    normalizedStart + integerOr(count, 0) - 1,
    normalizedStart,
    lineStarts.length
  );
  const lines: LogLine[] = [];

  for (let lineNumber = normalizedStart; lineNumber <= normalizedEnd; lineNumber += 1) {
    const line = getLogLine(source, lineStarts, lineNumber);
    if (line) lines.push(line);
  }

  return lines;
}

function collectDiagnostics(source: string): LogDocumentDiagnostic[] {
  const diagnostics = new Set<LogDocumentDiagnostic>();

  if (source.length === 0) diagnostics.add("empty-log");
  if (source.endsWith("\n")) diagnostics.add("trailing-newline");
  if (source.includes("\r\n")) diagnostics.add("contains-crlf");
  if (/(^|[^\r])\r(?!\n)/.test(source)) diagnostics.add("contains-cr-only");
  if (diagnostics.has("contains-crlf") && diagnostics.has("contains-cr-only")) {
    diagnostics.add("mixed-newlines");
  }

  return [...diagnostics];
}

function applyAnsiCodes(style: AnsiStyle, codeText: string): void {
  const codes = codeText.length > 0 ? codeText.split(";").map(Number) : [0];

  for (let index = 0; index < codes.length; index += 1) {
    const code = codes[index];
    if (code === undefined) continue;

    if (code === 0) {
      resetAnsiStyle(style);
    } else if (code === 1) {
      style.bold = true;
    } else if (code === 3) {
      style.italic = true;
    } else if (code === 4) {
      style.underline = true;
    } else if (code === 22) {
      delete style.bold;
    } else if (code === 23) {
      delete style.italic;
    } else if (code === 24) {
      delete style.underline;
    } else if (code === 39) {
      resetAnsiForeground(style);
    } else if (code === 49) {
      resetAnsiBackground(style);
    } else if (code >= 30 && code <= 37) {
      resetAnsiForeground(style);
      style.color = normalColors[code - 30] as AnsiColor;
    } else if (code >= 90 && code <= 97) {
      resetAnsiForeground(style);
      style.color = brightColors[code - 90] as AnsiColor;
    } else if (code >= 40 && code <= 47) {
      resetAnsiBackground(style);
      style.backgroundColor = normalColors[code - 40] as AnsiColor;
    } else if (code >= 100 && code <= 107) {
      resetAnsiBackground(style);
      style.backgroundColor = brightColors[code - 100] as AnsiColor;
    } else if (code === 38 || code === 48) {
      const parsed = parseExtendedAnsiColor(codes, index + 1);
      if (parsed) {
        if (code === 38) {
          resetAnsiForeground(style);
          if (parsed.kind === "indexed") style.colorCode = parsed.value;
          else style.rgbColor = parsed.value;
        } else {
          resetAnsiBackground(style);
          if (parsed.kind === "indexed") style.backgroundColorCode = parsed.value;
          else style.rgbBackgroundColor = parsed.value;
        }
        index = parsed.nextIndex - 1;
      }
    }
  }
}

function resetAnsiStyle(style: AnsiStyle): void {
  delete style.bold;
  delete style.italic;
  delete style.underline;
  resetAnsiForeground(style);
  resetAnsiBackground(style);
}

function resetAnsiForeground(style: AnsiStyle): void {
  delete style.color;
  delete style.colorCode;
  delete style.rgbColor;
}

function resetAnsiBackground(style: AnsiStyle): void {
  delete style.backgroundColor;
  delete style.backgroundColorCode;
  delete style.rgbBackgroundColor;
}

function parseExtendedAnsiColor(
  codes: readonly number[],
  startIndex: number
):
  | { kind: "indexed"; value: number; nextIndex: number }
  | { kind: "rgb"; value: readonly [number, number, number]; nextIndex: number }
  | undefined {
  const mode = codes[startIndex];

  if (mode === 5) {
    const colorCode = codes[startIndex + 1];
    if (isByte(colorCode)) {
      return {
        kind: "indexed",
        value: colorCode,
        nextIndex: startIndex + 2
      };
    }
  }

  if (mode === 2) {
    const red = codes[startIndex + 1];
    const green = codes[startIndex + 2];
    const blue = codes[startIndex + 3];
    if (isByte(red) && isByte(green) && isByte(blue)) {
      return {
        kind: "rgb",
        value: [red, green, blue],
        nextIndex: startIndex + 4
      };
    }
  }

  return undefined;
}

function ansiStyleToClasses(style: AnsiStyle, classPrefix: string): string[] {
  const classes: string[] = [];
  if (style.bold) classes.push(`${classPrefix}-bold`);
  if (style.italic) classes.push(`${classPrefix}-italic`);
  if (style.underline) classes.push(`${classPrefix}-underline`);
  if (style.color) classes.push(`${classPrefix}-fg-${style.color}`);
  if (style.backgroundColor) classes.push(`${classPrefix}-bg-${style.backgroundColor}`);
  if (style.colorCode !== undefined) classes.push(`${classPrefix}-fg-ansi-${style.colorCode}`);
  if (style.backgroundColorCode !== undefined) {
    classes.push(`${classPrefix}-bg-ansi-${style.backgroundColorCode}`);
  }
  return classes;
}

function ansiStyleToInlineStyle(style: AnsiStyle): string {
  const declarations: string[] = [];
  if (style.rgbColor) declarations.push(`color: rgb(${style.rgbColor.join(" ")})`);
  if (style.rgbBackgroundColor) {
    declarations.push(`background-color: rgb(${style.rgbBackgroundColor.join(" ")})`);
  }
  return declarations.join("; ");
}

function renderHighlightedText(
  input: string,
  options: RenderLogLineHtmlOptions,
  classPrefix: string
): string {
  const query = options.highlightQuery;
  if (!query) return escapeHtml(input);

  const haystack = options.caseSensitiveHighlight ? input : input.toLowerCase();
  const needle = options.caseSensitiveHighlight ? query : query.toLowerCase();
  if (needle.length === 0) return escapeHtml(input);

  let cursor = 0;
  let output = "";

  while (cursor < input.length) {
    const start = haystack.indexOf(needle, cursor);
    if (start === -1) {
      output += escapeHtml(input.slice(cursor));
      break;
    }

    output += escapeHtml(input.slice(cursor, start));
    output += `<mark class="${escapeHtml(`${classPrefix}-match`)}">${escapeHtml(
      input.slice(start, start + query.length)
    )}</mark>`;
    cursor = start + query.length;
  }

  return output;
}

function snapshotSearchStep(
  query: string,
  searchedLineCount: number,
  nextLine: number,
  results: LogSearchMatch[],
  matches: LogSearchMatch[],
  done: boolean
): LogSearchStep {
  return {
    done,
    query,
    searchedLineCount,
    nextLine,
    resultCount: results.length,
    matches,
    results
  };
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function isByte(value: number | undefined): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 255;
}

function integerOr(value: number | undefined, fallback: number): number {
  return Math.floor(finiteOr(value ?? fallback, fallback));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
