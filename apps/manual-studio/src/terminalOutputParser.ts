export const DELIMITER_START = "<<<MANUAL_STUDIO_RESULT_START>>>";
export const DELIMITER_END = "<<<MANUAL_STUDIO_RESULT_END>>>";

// Comprehensive ANSI escape code regex matching colors, styles, cursor movements, and OSC/CSI sequences
const ANSI_REGEX = new RegExp(
  [
    "[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]+)*|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]*)*)?\\u0007)",
    "(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-ntqry=><~]))",
  ].join("|"),
  "g",
);

/**
 * Remove all ANSI escape sequences and normalize carriage returns.
 */
export function stripAnsi(text: string): string {
  return text
    .replace(ANSI_REGEX, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "");
}

export interface DelimitedResult {
  completed: boolean;
  result?: string;
  remaining: string;
}

/**
 * Extracts content enclosed between DELIMITER_START and DELIMITER_END.
 * If delimiters are found, strips ANSI codes from the result and returns remaining text.
 * Uses lastIndexOf to ensure it extracts the generated response rather than matching prompt echoes.
 */
export function extractDelimitedResult(buffer: string): DelimitedResult {
  // Strip ANSI before checking delimiter positions in case delimiters were broken up by styling codes
  const cleanBuffer = stripAnsi(buffer);

  const endIdx = cleanBuffer.lastIndexOf(DELIMITER_END);
  if (endIdx === -1) {
    return { completed: false, remaining: buffer };
  }

  const startIdx = cleanBuffer.lastIndexOf(DELIMITER_START, endIdx);
  if (startIdx === -1 || startIdx + DELIMITER_START.length > endIdx) {
    return { completed: false, remaining: buffer };
  }

  const contentStart = startIdx + DELIMITER_START.length;
  const result = cleanBuffer.slice(contentStart, endIdx).trim();
  const remaining = cleanBuffer.slice(endIdx + DELIMITER_END.length);

  return {
    completed: true,
    result,
    remaining,
  };
}
