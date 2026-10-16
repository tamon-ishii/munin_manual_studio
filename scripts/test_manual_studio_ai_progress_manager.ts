import assert from 'node:assert/strict';
import { AiProgressManager } from '../apps/manual-studio/src/aiProgressManager';

const manager = new AiProgressManager();
assert.equal(manager.isRunning, false);

manager.start({ connection: 'API（gpt-4）', operation: '下書き生成', root: '/test-project' });
assert.equal(manager.isRunning, true);
assert.equal(manager.root, '/test-project');

manager.log('テストログ1');
assert.equal(manager.logs.length, 1);
assert.ok(manager.logs[0].includes('テストログ1'));

const elapsed = manager.computeElapsed();
assert.equal(elapsed.seconds, 0);
assert.equal(elapsed.formatted, '00:00');
assert.equal(elapsed.isWaitingLong, false);

let cancelSent = false;
const cancelPromise = manager.requestCancel(async (root) => {
  assert.equal(root, '/test-project');
  cancelSent = true;
});
assert.ok(cancelPromise);
assert.equal(cancelSent, true);
assert.equal(manager.isCancelling, true);

// Double cancel request should be ignored
assert.equal(manager.requestCancel(async () => {}), undefined);

const outcome = await manager.stop();
assert.equal(outcome.cancelled, true);
assert.equal(manager.isRunning, false);
assert.equal(manager.root, null);

console.log('AiProgressManager unit tests passed successfully!');
