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

console.log("terminalOutputParser tests passed!");
