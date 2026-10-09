import type { ExecutionRun } from './executionHistory';

export type AiPhase = 'idle' | 'generating' | 'review' | 'capturing' | 'completed' | 'partial' | 'cancelled' | 'restored';
const phases: Record<AiPhase, string> = {
  idle: 'AI更新を開始できます', generating: '生成中', review: 'レビュー待ち：採用すると原稿へ保存します',
  capturing: '撮影中', completed: '採用済み', partial: '一部未完了：結果を確認してください', cancelled: '中断', restored: '更新前へ復元済み',
};
export function setAiPhase(container: HTMLElement, phase: AiPhase): void {
  container.hidden = phase === 'idle';
  container.dataset.phase = phase;
  container.textContent = phases[phase];
}

export function executionCounts(run: Pick<ExecutionRun, 'entries'>): { succeeded: number; failed: number; pending: number } {
  return {
    succeeded: run.entries.filter(entry => entry.status === 'succeeded').length,
    failed: run.entries.filter(entry => entry.status === 'failed').length,
    pending: run.entries.filter(entry => !['succeeded', 'failed'].includes(entry.status)).length,
  };
}
export function executionSummary(run: Pick<ExecutionRun, 'entries'>): string {
  const counts = executionCounts(run);
  return `成功${counts.succeeded}件・失敗${counts.failed}件・未完了${counts.pending}件`;
}
export function renderExecutionResult(container: HTMLElement, run: ExecutionRun | undefined, actions: {
  resume: (id: string) => void; history: () => void;
}): void {
  container.replaceChildren(); container.hidden = !run;
  if (!run) return;
  container.dataset.state = run.status;
  const title = document.createElement('summary');
  title.textContent = run.status === 'rolled_back' ? '文書と画像を更新前へ戻しました' : run.status === 'completed' ? 'AI更新を採用しました' : 'AI更新に未完了の処理があります';
  const summary = document.createElement('p'); summary.textContent = executionSummary(run);
  const buttons = document.createElement('div'); buttons.className = 'actions';
  const counts = executionCounts(run);
  if (counts.failed || counts.pending || run.status === 'rolled_back') {
    const resume = document.createElement('button'); resume.type = 'button'; resume.className = 'primary';
    resume.textContent = run.status === 'rolled_back' ? '更新をやり直す' : '未完了分を確認して再実行';
    resume.addEventListener('click', () => actions.resume(run.id)); buttons.append(resume);
  }
  const history = document.createElement('button'); history.type = 'button'; history.textContent = '実行記録・画像を確認';
  history.addEventListener('click', actions.history); buttons.append(history);
  container.append(title, summary, buttons);
}
