import test from "node:test";
import assert from "node:assert/strict";
import { buildCardMarkdown } from "../src/card.js";

test("卡片是合法 JSON 且包含 markdown 元素", () => {
  const card = JSON.parse(buildCardMarkdown("**hi**"));
  assert.equal(card.config.wide_screen_mode, true);
  assert.equal(card.elements.length, 1);
  assert.deepEqual(card.elements[0], { tag: "markdown", content: "**hi**" });
});

test("空内容也能构造卡片", () => {
  const card = JSON.parse(buildCardMarkdown(""));
  assert.equal(card.elements[0].content, "");
});

test("代码块与引号被正确转义", () => {
  const content = '```js\nconsole.log("hi")\n```';
  const card = JSON.parse(buildCardMarkdown(content));
  assert.equal(card.elements[0].content, content);
});

test("可以关闭宽屏模式", () => {
  const card = JSON.parse(buildCardMarkdown("x", { wide: false }));
  assert.equal(card.config.wide_screen_mode, false);
});

test("非字符串内容被安全转换", () => {
  const card = JSON.parse(buildCardMarkdown(null));
  assert.equal(card.elements[0].content, "");
});