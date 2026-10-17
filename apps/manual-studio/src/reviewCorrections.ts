import type { ReviewFinding } from './readerReview';

export function hasReviewReplacement(finding: ReviewFinding): boolean {
  return typeof finding.replacement === 'string' && finding.replacement !== finding.quote;
}

export function applyReviewCorrections(content: string, issues: ReviewFinding[], selected: ReviewFinding[]) {
  const edits = selected.filter(hasReviewReplacement).sort((a, b) => a.start - b.start);
  for (let index = 0; index < edits.length; index++) {
    const edit = edits[index];
    if (!Number.isInteger(edit.start) || !Number.isInteger(edit.end) || edit.start < 0 || edit.start >= edit.end || edit.end > content.length || content.slice(edit.start, edit.end) !== edit.quote) {
      throw new Error('原稿が変更されました。レビューを実行し直してください。');
    }
    if (index && edits[index - 1].end > edit.start) {
      throw new Error('修正範囲が重なる案があります。個別に適用してください。');
    }
  }
  let next = content;
  for (const edit of [...edits].reverse()) next = next.slice(0, edit.start) + edit.replacement! + next.slice(edit.end);
  const remaining = issues.filter(issue => !edits.some(edit => issue.start < edit.end && issue.end > edit.start)).map(issue => {
    const delta = edits.filter(edit => edit.end <= issue.start).reduce((sum, edit) => sum + edit.replacement!.length - (edit.end - edit.start), 0);
    return { ...issue, start: issue.start + delta, end: issue.end + delta };
  });
  return { content: next, issues: remaining, applied: edits.length };
}
