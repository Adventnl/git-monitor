import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyNodeSelection } from '../src/nodeSelection.ts';

test('clicking a different repository replaces the previous selection', () => {
  assert.deepEqual(applyNodeSelection([
    { type: 'select', id: 'a', selected: false },
    { type: 'select', id: 'b', selected: true },
  ], ['a']), ['b']);
});

test('multi-selection adds paths once and removes only deselected paths', () => {
  const selected = applyNodeSelection([
    { type: 'select', id: 'C:\\repos\\a', selected: true },
    { type: 'select', id: '/Users/test/b', selected: true },
    { type: 'select', id: '/Users/test/b', selected: true },
  ], ['C:\\repos\\a']);
  assert.deepEqual(selected, ['C:\\repos\\a', '/Users/test/b']);
  assert.deepEqual(applyNodeSelection([{ type: 'remove', id: 'C:\\repos\\a' }], selected), ['/Users/test/b']);
});

test('repeated events and measurements preserve the selection reference', () => {
  const previous = ['a'];
  assert.equal(applyNodeSelection([{ type: 'select', id: 'a', selected: true }], previous), previous);
  assert.equal(applyNodeSelection([{ type: 'dimensions', id: 'a', dimensions: { width: 170, height: 90 } }], previous), previous);
  assert.equal(applyNodeSelection([], previous), previous);
});
