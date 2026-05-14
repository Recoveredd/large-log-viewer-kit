import { describe, expect, it } from "vitest";
import {
  createLogDocument,
  createLogSearchSession,
  escapeHtml,
  getVirtualLogWindow,
  parseAnsiLine,
  renderLogLineHtml,
  stripAnsi
} from "../src/index.js";

describe("createLogDocument", () => {
  it("indexes lines without requiring a split array", () => {
    const document = createLogDocument("first\nsecond\nthird");

    expect(document.lineCount).toBe(3);
    expect(document.length).toBe(18);
    expect(document.getLine(2)).toEqual({
      lineNumber: 2,
      text: "second",
      startOffset: 6,
      endOffset: 12,
      hasNewline: true
    });
  });

  it("handles CRLF lines and reports newline diagnostics", () => {
    const document = createLogDocument("one\r\ntwo\r\n");

    expect(document.lineCount).toBe(2);
    expect(document.diagnostics).toEqual(["trailing-newline", "contains-crlf"]);
    expect(document.getLine(1)?.text).toBe("one");
    expect(document.getLine(2)?.text).toBe("two");
  });

  it("can keep a trailing empty line when requested", () => {
    const document = createLogDocument("one\n", { keepTrailingEmptyLine: true });

    expect(document.lineCount).toBe(2);
    expect(document.getLine(2)).toMatchObject({
      lineNumber: 2,
      text: "",
      hasNewline: false
    });
  });

  it("returns bounded ranges", () => {
    const document = createLogDocument("a\nb\nc\nd");

    expect(document.getLines(2, 10).map((line) => line.text)).toEqual(["b", "c", "d"]);
    expect(document.getLine(0)).toBeUndefined();
    expect(document.getLine(99)).toBeUndefined();
  });
});

describe("virtual windows", () => {
  it("returns only visible rows plus overscan", () => {
    const source = Array.from({ length: 1_000 }, (_, index) => `line ${index + 1}`).join("\n");
    const document = createLogDocument(source);
    const window = document.getWindow({
      scrollTop: 20 * 500,
      viewportHeight: 20 * 10,
      rowHeight: 20,
      overscan: 2
    });

    expect(window.totalHeight).toBe(20_000);
    expect(window.visibleStartLine).toBe(501);
    expect(window.visibleEndLine).toBe(510);
    expect(window.startLine).toBe(499);
    expect(window.endLine).toBe(512);
    expect(window.rows).toHaveLength(14);
    expect(window.rows[0]?.text).toBe("line 499");
  });

  it("can work with a document-like adapter", () => {
    const document = createLogDocument("a\nb\nc");

    expect(
      getVirtualLogWindow(document, {
        scrollTop: Number.NaN,
        viewportHeight: 20,
        rowHeight: 10
      }).rows.map((line) => line.text)
    ).toEqual(["a", "b", "c"]);
  });

  it("keeps invalid numeric viewport values bounded", () => {
    const document = createLogDocument("a\nb\nc");

    const window = document.getWindow({
      scrollTop: Infinity,
      viewportHeight: Number.NaN,
      rowHeight: 0,
      overscan: Number.NaN
    });

    expect(window.startLine).toBe(1);
    expect(window.endLine).toBe(3);
    expect(window.rows).toHaveLength(3);
  });
});

describe("search sessions", () => {
  it("searches incrementally by line chunks", () => {
    const document = createLogDocument("info boot\nwarn disk\ninfo done\nwarn cpu");
    const session = document.createSearch("warn", { includeLineText: true });

    const first = session.next(2);
    expect(first.done).toBe(false);
    expect(first.searchedLineCount).toBe(2);
    expect(first.results).toEqual([
      {
        lineNumber: 2,
        columnStart: 0,
        columnEnd: 4,
        startOffset: 10,
        endOffset: 14,
        lineText: "warn disk"
      }
    ]);

    const second = session.next(2);
    expect(second.done).toBe(true);
    expect(second.resultCount).toBe(2);
    expect(second.results[1]).toMatchObject({
      lineNumber: 4,
      columnStart: 0,
      columnEnd: 4
    });
  });

  it("honors case sensitivity, ranges and max results", () => {
    const document = createLogDocument("Error\nerror\nERROR");
    const session = createLogSearchSession(document, "error", {
      caseSensitive: false,
      startLine: 2,
      maxResults: 1
    });

    const step = session.next(100);
    expect(step.done).toBe(true);
    expect(step.results).toHaveLength(1);
    expect(step.results[0]?.lineNumber).toBe(2);
  });

  it("treats an empty query as already done", () => {
    const session = createLogDocument("abc").createSearch("");

    expect(session.done).toBe(true);
    expect(session.next()).toMatchObject({
      done: true,
      resultCount: 0
    });
  });

  it("keeps invalid chunk sizes from stalling progress", () => {
    const session = createLogDocument("a\nb\nc").createSearch("c");

    expect(session.next(Number.NaN)).toMatchObject({
      done: true,
      searchedLineCount: 3,
      resultCount: 1
    });
  });
});

describe("ANSI and HTML rendering", () => {
  it("parses common ANSI SGR color and style codes", () => {
    expect(parseAnsiLine("\x1b[31;1mERR\x1b[0m ok")).toEqual([
      {
        text: "ERR",
        style: {
          bold: true,
          color: "red"
        }
      },
      {
        text: " ok",
        style: {}
      }
    ]);
  });

  it("strips ANSI escapes", () => {
    expect(stripAnsi("\x1b[32mOK\x1b[0m")).toBe("OK");
  });

  it("escapes HTML and highlights text safely", () => {
    expect(escapeHtml("<script>alert('x')</script>")).toBe(
      "&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;"
    );

    expect(renderLogLineHtml("<warn>", { highlightQuery: "warn" })).toBe(
      "&lt;<mark class=\"llv-match\">warn</mark>&gt;"
    );
  });

  it("renders ANSI classes only around visible line content", () => {
    expect(renderLogLineHtml("\x1b[91mFAIL\x1b[0m", { ansi: true })).toBe(
      '<span class="llv-fg-bright-red">FAIL</span>'
    );
  });
});
