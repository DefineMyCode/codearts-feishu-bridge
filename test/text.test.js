import assert from "node:assert/strict";
import test from "node:test";
import { chunkText } from "../src/text.js";

test("空内容返回占位提示", () => {
  assert.deepEqual(chunkText("", 100, 3), ["（码道没有返回内容）"]);
  assert.deepEqual(chunkText("   ", 100, 3), ["（码道没有返回内容）"]);
});

test("短内容只产生一个分段", () => {
  assert.deepEqual(chunkText("hello", 100, 3), ["hello"]);
});

test("优先在换行处切分", () => {
  const text = "a".repeat(60) + "\n" + "b".repeat(60);
  const chunks = chunkText(text, 100, 3);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0], "a".repeat(60));
  assert.equal(chunks[1], "b".repeat(60));
});

test("超过最大段数时给出截断提示", () => {
  const chunks = chunkText("x".repeat(500), 100, 2);
  assert.equal(chunks.length, 2);
  assert.match(chunks[1], /已截断/);
  assert.ok(chunks[1].length <= 100);
});

test("多段内容保持顺序且不丢字", () => {
  const lines = Array.from({ length: 10 }, (_, i) => `line-${i}`);
  const chunks = chunkText(lines.join("\n"), 30, 10);
  assert.equal(chunks.join("\n"), lines.join("\n"));
});