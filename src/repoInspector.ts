// Share inspections across automatic and manual refreshes, with a fixed process
// budget even when many repositories change at once.
export function createRepoInspector<T>(inspect: (path: string) => Promise<T>, concurrency = 4) {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('Invalid inspection concurrency');
  const pending = new Map<string, { promise: Promise<T>; state: { started: boolean; changed: boolean } }>();
  const queue: Array<() => void> = [];
  let active = 0;

  const drain = () => {
    while (active < concurrency && queue.length) {
      active++;
      queue.shift()!();
    }
  };

  return (path: string, changed = false): Promise<T> => {
    const existing = pending.get(path);
    if (existing) {
      // A file change during an active inspection needs one more read. Changes
      // while queued will already be visible when that inspection starts.
      if (changed && existing.state.started) existing.state.changed = true;
      return existing.promise;
    }
    const state = { started: false, changed: false };
    const promise = new Promise<T>((resolve, reject) => {
      queue.push(() => {
        state.started = true;
        const finish = () => {
          pending.delete(path);
          active--;
          drain();
        };
        const run = async () => {
          let value: T;
          do {
            state.changed = false;
            value = await inspect(path);
          } while (state.changed);
          return value;
        };
        Promise.resolve().then(run).then(value => {
          finish();
          resolve(value);
        }, error => {
          finish();
          reject(error);
        });
      });
    });
    pending.set(path, { promise, state });
    drain();
    return promise;
  };
}
