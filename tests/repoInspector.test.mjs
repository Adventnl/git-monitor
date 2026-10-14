import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRepoInspector } from '../src/repoInspector.ts';

test('bursts share inspections and respect the process budget', async () => {
  let active = 0;
  let peak = 0;
  const calls = [];
  const releases = [];
  const inspect = createRepoInspector(async path => {
    calls.push(path);
    peak = Math.max(peak, ++active);
    await new Promise(resolve => releases.push(resolve));
    active--;
    return path;
  }, 2);
  const jobs = ['a', 'b', 'c', 'd'].map(path => inspect(path));
  assert.equal(inspect('a'), jobs[0]);
  assert.equal(inspect('c'), jobs[2]);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ['a', 'b']);
  releases.splice(0).forEach(release => release());
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ['a', 'b', 'c', 'd']);
  releases.splice(0).forEach(release => release());
  assert.deepEqual(await Promise.all(jobs), ['a', 'b', 'c', 'd']);
  assert.equal(peak, 2);
});

test('failure frees the queue and permits a later retry', async () => {
  let attempts = 0;
  const inspect = createRepoInspector(path => {
    if (path === 'bad' && attempts++ === 0) throw new Error('Git unavailable');
    return Promise.resolve(path);
  }, 1);
  const failed = inspect('bad');
  const queued = inspect('good');
  await assert.rejects(failed, /Git unavailable/);
  assert.equal(await queued, 'good');
  assert.equal(await inspect('bad'), 'bad');
});

test('completed inspections are not cached', async () => {
  let calls = 0;
  const inspect = createRepoInspector(async () => ++calls);
  assert.equal(await inspect('repo'), 1);
  assert.equal(await inspect('repo'), 2);
});

test('a change during inspection is read again without overlapping processes', async () => {
  let calls = 0;
  let release;
  const inspect = createRepoInspector(async () => {
    const snapshot = ++calls;
    if (calls === 1) await new Promise(resolve => release = resolve);
    return snapshot;
  });
  const first = inspect('repo');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(inspect('repo', true), first);
  assert.equal(inspect('repo', true), first);
  assert.equal(calls, 1);
  release();
  assert.equal(await first, 2);
  assert.equal(calls, 2);
});
