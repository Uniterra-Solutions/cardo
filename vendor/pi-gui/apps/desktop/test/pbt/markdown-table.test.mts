import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToString } from "react-dom/server";
import { MessageMarkdown } from "../../out-pbt/desktop/src/message-markdown.js";

const TABLE_MD = [
  "| 工具 | 功能 |",
  "| --- | --- |",
  "| plan | 針對複雜功能需求，跑完整的規劃流程（PRD → 研究 → 驗收標準 → 任務 DAG），產出 .plan/ 下的規劃文件 |",
  "| execute | 執行已批准的計畫，驅動任務 DAG 逐層實作（變更會留在工作區未提交） |",
  "| simplify | 對未提交的 diff 做簡化審查，找出可以精簡的程式碼 |",
  "| review | 對未提交的 diff 做對抗式審查，抓 bug、安全性問題與契約違反 |",
].join("\n");

const timelineCssPath = resolve(import.meta.dirname, "..", "..", "src", "styles", "timeline.css");
const timelineCss = readFileSync(timelineCssPath, "utf8");

test("markdown table renders inside the .message__table-wrap scroll wrapper", () => {
  const html = renderToString(MessageMarkdown({ text: TABLE_MD }));
  assert.match(html, /class="message__table-wrap"/, "expected a table wrapper div");
  assert.match(html, /<table>/, "expected a <table> element");
  assert.match(html, /<th>/, "expected a header cell");
  assert.match(html, /<td>/, "expected a body cell");
  // Wrapper must be a direct child of .message__content so it participates in
  // the markdown grid gap and max-width rules.
  assert.match(html, /message__content[\s\S]*message__table-wrap/, "wrapper inside message content");
});

test("table CSS contract: hairline border, sharp radius, scroll, header tint", () => {
  // Wrapper: visible border in both themes (uses --line), sharp corners,
  // horizontal scroll instead of squeezing columns.
  assert.match(timelineCss, /\.message__table-wrap\s*{[^}]*overflow-x:\s*auto/, "wrapper scrolls horizontally");
  assert.match(timelineCss, /\.message__table-wrap\s*{[^}]*border:\s*1px solid var\(--line\)/, "wrapper has hairline border");
  assert.match(timelineCss, /\.message__table-wrap\s*{[^}]*border-radius:\s*var\(--radius-lg\)/, "sharp corner radius");
  // Cells must NOT inherit .message__content's overflow-wrap: anywhere, which
  // caused mid-word breaks (execut/e).
  assert.match(
    timelineCss,
    /\.message__content \.message__table-wrap th,[\s\S]*?overflow-wrap:\s*normal[\s\S]*?word-break:\s*normal/,
    "cells reset overflow-wrap/word-break to normal",
  );
  // Header: muted surface tint + semibold, distinct from body cells.
  assert.match(timelineCss, /\.message__content \.message__table-wrap th\s*{[^}]*background:\s*var\(--surface-muted\)/, "header uses surface-muted tint");
  assert.match(timelineCss, /\.message__content \.message__table-wrap th\s*{[^}]*white-space:\s*nowrap/, "header does not wrap");
});

test("code block regex still strips exactly one trailing newline", () => {
  const html = renderToString(MessageMarkdown({ text: "```ts\nconst x = 1;\n```" }));
  assert.ok(!html.includes("\\n"), "escaped backslash-n must not appear in rendered output");
});
