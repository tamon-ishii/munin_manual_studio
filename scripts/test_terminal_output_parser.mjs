import assert from "node:assert/strict";
import { stripAnsi, extractDelimitedResult } from "../apps/manual-studio/src/terminalOutputParser.ts";

// Test ANSI stripping
const colored = "\u001b[32mHello\u001b[0m \u001b[1mWorld\u001b[0m";
assert.equal(stripAnsi(colored), "Hello World");

// Test delimited extraction - incomplete
const chunk1 = "Thinking...\n<<<MANUAL_STUDIO_RESULT_START>>>\n# Title\nContent";
const res1 = extractDelimitedResult(chunk1);
assert.equal(res1.completed, false);
assert.equal(res1.result, undefined);

// Test delimited extraction - complete
const chunk2 = chunk1 + "\n<<<MANUAL_STUDIO_RESULT_END>>>\nDone!";
const res2 = extractDelimitedResult(chunk2);
assert.equal(res2.completed, true);
assert.equal(res2.result?.trim(), "# Title\nContent");
assert.equal(res2.remaining, "\nDone!");

// Test ANSI stripped from inside delimited result
const coloredDelimited = "Start\n<<<MANUAL_STUDIO_RESULT_START>>>\n\u001b[34m# Section\u001b[0m\n<<<MANUAL_STUDIO_RESULT_END>>>\nTrailing";
const res3 = extractDelimitedResult(coloredDelimited);
assert.equal(res3.completed, true);
assert.equal(res3.result?.trim(), "# Section");

// Test prompt echo containing START marker only must not complete
const promptEcho = "マニュアル作成タスク\n開始マーカー <<<MANUAL_STUDIO_RESULT_START>>> を出力し、終了マーカーを出力してください。\n";
const resPromptOnly = extractDelimitedResult(promptEcho);
assert.equal(resPromptOnly.completed, false);
assert.equal(resPromptOnly.result, undefined);

// Test prompt echo followed by AI response extracts ONLY the AI response
const chunkWithEcho = promptEcho + "Thinking...\n<<<MANUAL_STUDIO_RESULT_START>>>\n# Real Output\nContent\n<<<MANUAL_STUDIO_RESULT_END>>>\nDone!";
const resWithEcho = extractDelimitedResult(chunkWithEcho);
assert.equal(resWithEcho.completed, true);
assert.equal(resWithEcho.result?.trim(), "# Real Output\nContent");

// Test bracketed paste stripping
assert.equal(stripAnsi("\x1b[200~Pasted text\x1b[201~"), "Pasted text");

console.log("terminalOutputParser tests passed!");
