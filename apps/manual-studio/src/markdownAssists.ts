/** A single replacement in a Markdown document, with the resulting selection. */
export interface MarkdownEdit {
  start: number;
  end: number;
  text: string;
  selectionStart: number;
  selectionEnd: number;
}

function edit(start: number, end: number, replacement: string, selectionStart = start + replacement.length, selectionEnd = selectionStart): MarkdownEdit {
  return { start, end, text: replacement, selectionStart, selectionEnd };
}

function lineStartAt(markdown: string, offset: number): number {
  return offset <= 0 ? 0 : markdown.lastIndexOf('\n', offset - 1) + 1;
}

function selectedLineEnd(markdown: string, selectionEnd: number, start: number): number {
  // A selection ending just after a newline does not include the next line.
  if (selectionEnd > start && markdown[selectionEnd - 1] === '\n') return selectionEnd - 1;
  const newline = markdown.indexOf('\n', selectionEnd);
  return newline < 0 ? markdown.length : newline;
}

/** Replace each selected line's ATX heading marker with the requested level. */
export function changeHeadingLevel(markdown: string, selectionStart: number, selectionEnd: number, level: number): MarkdownEdit {
  if (!Number.isInteger(level) || level < 1 || level > 6) throw new RangeError('Heading level must be an integer from 1 to 6');
  const start = lineStartAt(markdown, selectionStart);
  const end = selectedLineEnd(markdown, selectionEnd, start);
  const source = markdown.slice(start, end);
  const replacement = source.split('\n').map((line) => {
    const heading = /^(\s*)(#{1,6})(\s+)(.*)$/.exec(line);
    return heading ? `${heading[1]}${'#'.repeat(level)}${heading[3]}${heading[4]}` : line.replace(/^(\s*)/, `$1${'#'.repeat(level)} `);
  }).join('\n');
  return edit(start, end, replacement, start, start + replacement.length);
}

/** Wrap the selected text in Markdown strike-through markers. */
export function toggleStrikethrough(markdown: string, selectionStart: number, selectionEnd: number): MarkdownEdit {
  const selected = markdown.slice(selectionStart, selectionEnd);
  if (selected.startsWith('~~') && selected.endsWith('~~') && selected.length >= 4) {
    return edit(selectionStart, selectionEnd, selected.slice(2, -2), selectionStart, selectionEnd - 4);
  }
  return edit(selectionStart, selectionEnd, `~~${selected}~~`, selectionStart + 2, selectionStart + 2 + selected.length);
}

/** Add or remove unchecked task markers on the selected lines. */
export function toggleTaskList(markdown: string, selectionStart: number, selectionEnd: number): MarkdownEdit {
  const start = lineStartAt(markdown, selectionStart);
  const end = selectedLineEnd(markdown, selectionEnd, start);
  const lines = markdown.slice(start, end).split('\n');
  const allTasks = lines.every((line) => /^\s*(?:[-*+]\s+)?\[[ xX]\]\s+/.test(line));
  const replacement = lines.map((line) => {
    if (allTasks) return line.replace(/^(\s*)(?:[-*+]\s+)?\[[ xX]\]\s+/, '$1');
    if (/^\s*(?:[-*+]\s+)?\[[ xX]\]\s+/.test(line)) return line;
    return line.replace(/^(\s*)([-*+]\s+)?/, (_whole, indent: string, bullet: string | undefined) => `${indent}${bullet ?? '- ' }[ ] `);
  }).join('\n');
  return edit(start, end, replacement, start, start + replacement.length);
}

/** Indent or unindent every selected line by one level (two spaces). */
export function changeIndent(markdown: string, selectionStart: number, selectionEnd: number, direction: 'indent' | 'unindent'): MarkdownEdit {
  const start = lineStartAt(markdown, selectionStart);
  const end = selectedLineEnd(markdown, selectionEnd, start);
  const lines = markdown.slice(start, end).split('\n');
  const transformed = lines.map((line) => {
    if (direction === 'indent') return `  ${line}`;
    if (line.startsWith('\t')) return line.slice(1);
    return line.replace(/^ {1,2}/, '');
  });
  const replacement = transformed.join('\n');
  const delta = replacement.length - (end - start);
  const prefixMatch = /^( {1,2}|\t)/.exec(lines[0] ?? '');
  const firstDelta = direction === 'indent' ? 2 : -(prefixMatch?.[0].length ?? 0);
  const mapFirstLineOffset = (offset: number) => {
    const relative = offset - start;
    const oldIndent = prefixMatch?.[0].length ?? 0;
    if (relative <= oldIndent) return start + Math.max(0, relative + firstDelta);
    return offset + firstDelta;
  };
  const mappedStart = selectionStart <= end ? mapFirstLineOffset(selectionStart) : selectionStart;
  const mappedEnd = selectionEnd > start + (lines[0]?.length ?? 0) ? selectionEnd + delta : mapFirstLineOffset(selectionEnd);
  return edit(start, end, replacement, Math.max(start, mappedStart), Math.max(start, mappedEnd));
}

const listPrefix = /^(\s*(?:>\s*)*)([-+*]|\d+[.)])\s+(\[[ xX]\]\s+)?(.*)$/;
const quotePrefix = /^(\s*(?:>\s*)+)(.*)$/;

/** Build the edit for Enter. `lineStart` and `cursor` are document offsets. */
export function continueMarkdownList(markdown: string, cursor: number): MarkdownEdit {
  const lineStart = lineStartAt(markdown, cursor);
  const lineEndAt = markdown.indexOf('\n', cursor);
  const lineEnd = lineEndAt < 0 ? markdown.length : lineEndAt;
  const before = markdown.slice(lineStart, cursor);
  const after = markdown.slice(cursor, lineEnd);

  // Fences are tracked from the start of the document so Enter remains plain inside code blocks.
  let fence: { char: string; length: number } | undefined;
  for (const line of markdown.slice(0, lineStart).split('\n')) {
    if (fence) {
      const close = new RegExp(`^ {0,3}${fence.char}{${fence.length},}\\s*$`);
      if (close.test(line)) fence = undefined;
    } else {
      const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (open && !(open[1][0] === '`' && open[2].includes('`'))) fence = { char: open[1][0], length: open[1].length };
    }
  }
  if (fence) return edit(cursor, cursor, '\n');

  const match = listPrefix.exec(before);
  const quote = quotePrefix.exec(before);
  if (match) {
    const [, lead, marker, task = '', content] = match;
    const empty = content.trim() === '' && after.trim() === '';
    if (empty) {
      const quotePrefixText = /^ {0,3}(?:>\s*)+/.exec(lead)?.[0] ?? '';
      const prefixStart = lineStart + quotePrefixText.length;
      const removeFrom = prefixStart;
      const removeTo = lineEnd;
      const replacement = lineEnd < markdown.length ? '' : '\n';
      return edit(removeFrom, removeTo, replacement, removeFrom + replacement.length, removeFrom + replacement.length);
    }
    const nextMarker = /^\d/.test(marker) ? `${Number(marker.slice(0, -1)) + 1}${marker.slice(-1)}` : marker;
    return edit(cursor, cursor, `\n${lead}${nextMarker} ${task ? '[ ] ' : ''}`);
  }
  if (quote) {
    const [, prefix, content] = quote;
    if (content.trim() === '' && after.trim() === '') {
      const removeFrom = lineStart;
      const replacement = lineEnd < markdown.length ? '' : '\n';
      return edit(removeFrom, lineEnd, replacement, removeFrom + replacement.length, removeFrom + replacement.length);
    }
    return edit(cursor, cursor, `\n${prefix}`);
  }
  return edit(cursor, cursor, '\n');
}
