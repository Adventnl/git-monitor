import type { NodeChange } from '@xyflow/react';

// Only user node changes update selection; observing the rendered selection and
// writing it back can race with the next controlled-node update.
export function applyNodeSelection(changes: NodeChange[], previous: string[]): string[] {
  if (!changes.some(change => change.type === 'select' || change.type === 'remove')) return previous;
  const selected = new Set(previous);
  for (const change of changes) {
    if (change.type === 'select') {
      if (change.selected) selected.add(change.id);
      else selected.delete(change.id);
    } else if (change.type === 'remove') {
      selected.delete(change.id);
    }
  }
  const next = [...selected];
  return next.length === previous.length && next.every((path, index) => path === previous[index])
    ? previous
    : next;
}
