import { expect, test } from '@playwright/test';

async function openApp(page, platform) {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.route('**/src/main.tsx', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: `
      import { mockIPC, mockWindows } from '/node_modules/@tauri-apps/api/mocks.js';
      const root = ${JSON.stringify(platform === 'mac' ? '/Users/test/repos/' : 'C:/repos/')};
      const repos = Array.from({ length: 48 }, (_, i) => ({
        path: root + 'repo-' + i, name: 'repo-' + i, branch: 'main', kind: 'repository',
        files: i % 2 ? [] : [{ path: 'file.txt', status: 'M', staged: false, unstaged: true }],
        ahead: 0, behind: 1, upstream: 'origin/main', remote: 'https://example.com/repo.git', error: null,
      }));
      let settings = { repos: repos.map(r => r.path), sections: [
        { id: 'first', name: 'First group', paths: repos.slice(0, 8).map(r => r.path) },
        { id: 'second', name: 'Second group', paths: repos.slice(8, 16).map(r => r.path) },
      ], layout: 'horizontal', positions: {}, viewport: [0, 0, 1], grid: true, autoMonitor: true, appearance: 'light' };
      mockWindows('main');
      window.__testInspections = 0;
      mockIPC(async (command, args) => {
        if (command === 'get_settings') return settings;
        if (command === 'update_settings') return settings = args.settings;
        if (command === 'inspect_repo') { window.__testInspections++; return repos.find(r => r.path === args.path); }
        if (command === 'plugin:app|version') return '0.2.0';
        if (command === 'plugin:updater|check') return null;
        if (command === 'git_version') return 'git version 2.50';
        if (command === 'github_connected') return false;
        if (command === 'bulk_operation') {
          const results = [];
          for (const [index, path] of args.request.paths.entries()) {
            const result = { path, status: 'success', detail: 'Done', committed: false, pushed: false };
            results.push(result);
            await window.__TAURI_INTERNALS__.invoke('plugin:event|emit', { event: 'bulk-progress', payload: { runId: args.request.runId, index: index + 1, total: args.request.paths.length, result } });
          }
          return results;
        }
        throw new Error('Unexpected test IPC command: ' + command);
      }, { shouldMockEvents: true });
      ${await response.text()}
    ` });
  });
  await page.goto('/');
  await expect(page.locator('.react-flow__node')).toHaveCount(48);
  return errors;
}

test('canvas selections and repository refreshes do not loop', async ({ page }, testInfo) => {
  const errors = await openApp(page, testInfo.project.name);
  const first = page.locator('.react-flow__node').filter({ hasText: /^repo-0main/ });
  await first.click();
  await expect(page.locator('.inspector')).toBeVisible();
  await page.locator('.react-flow__node').filter({ hasText: /^repo-1main/ }).click();
  await expect(page.locator('.inspector h2')).toHaveText('repo-1');
  await first.click();
  await expect(page.locator('.inspector h2')).toHaveText('repo-0');
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(1);
  await page.locator('.react-flow__node').filter({ hasText: /^repo-1main/ }).click({ modifiers: ['Shift'] });
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(2);
  await page.getByRole('button', { name: 'Close inspector' }).click();
  await page.getByRole('button', { name: 'More actions', exact: true }).click();
  await page.getByRole('button', { name: 'Select all visible', exact: true }).click();
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(48);
  await page.getByRole('button', { name: 'More actions', exact: true }).click();
  await page.getByRole('button', { name: 'Deselect all', exact: true }).click();
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(0);
  for (let i = 0; i < 6; i++) {
    await page.getByRole('button', { name: i % 2 ? 'Second group' : 'First group' }).click();
    await expect(page.locator('.react-flow__node')).toHaveCount(8);
    await page.getByRole('button', { name: 'Refresh visible repositories' }).click();
  }
  await page.getByRole('button', { name: 'All repositories' }).click();
  await expect(page.locator('.react-flow__node')).toHaveCount(48);
  await page.getByRole('button', { name: 'First group' }).click();
  await page.keyboard.press(testInfo.project.name === 'mac' ? 'Meta+f' : 'Control+f');
  await page.getByPlaceholder('Find a repository…').fill('repo-12');
  await page.locator('.search-results button').click();
  await expect(page.locator('.inspector h2')).toHaveText('repo-12');
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(1);
  await expect(page.locator('.react-flow__node.selected')).toContainText('repo-12');
  await expect(page.getByText('Something went wrong', { exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('bulk jobs and bursts of file updates keep the canvas usable', async ({ page }, testInfo) => {
  const errors = await openApp(page, testInfo.project.name);
  await page.getByRole('button', { name: 'Commit & Push All', exact: true }).click();
  await expect(page.locator('.bulk-list input:checked')).toHaveCount(24);
  await page.getByPlaceholder('Commit message', { exact: true }).fill('Test bulk work');
  await page.locator('.bulk-list input').first().uncheck();
  const inspections = await page.evaluate(() => window.__testInspections);
  await page.evaluate(async () => {
    const path = (await window.__TAURI_INTERNALS__.invoke('get_settings')).repos[0];
    await window.__TAURI_INTERNALS__.invoke('plugin:event|emit', { event: 'git-changed', payload: path + '/file.txt' });
  });
  await expect.poll(() => page.evaluate(() => window.__testInspections)).toBeGreaterThan(inspections);
  await expect(page.locator('.bulk-list input:checked')).toHaveCount(23);
  await page.locator('.dialog-actions').getByRole('button', { name: 'Commit & Push All', exact: true }).click();
  await expect(page.locator('.bulk-status')).toContainText('23 completed');
  await page.getByRole('button', { name: 'Show details' }).click();
  await expect(page.locator('.bulk-status-results > div')).toHaveCount(23);
  await page.getByRole('button', { name: 'Dismiss operation status' }).click();

  for (const action of ['Fetch All', 'Pull All']) {
    await page.getByRole('button', { name: 'More actions', exact: true }).click();
    await page.getByRole('button', { name: action, exact: true }).click();
    await page.locator('.dialog-actions').getByRole('button', { name: action, exact: true }).click();
    await expect(page.locator('.bulk-status')).toContainText('48 completed');
    await page.getByRole('button', { name: 'Dismiss operation status' }).click();
  }
  const beforeBurst = await page.evaluate(() => window.__testInspections);
  await page.evaluate(async () => {
    const paths = (await window.__TAURI_INTERNALS__.invoke('get_settings')).repos;
    await Promise.all(paths.flatMap(path => Array.from({ length: 4 }, () =>
      window.__TAURI_INTERNALS__.invoke('plugin:event|emit', { event: 'git-changed', payload: path + '/file.txt' })
    )));
  });
  await expect.poll(() => page.evaluate(() => window.__testInspections)).toBeGreaterThanOrEqual(beforeBurst + 48);
  await page.locator('.react-flow__node').filter({ hasText: /^repo-0main/ }).click();
  await page.locator('.react-flow__node').filter({ hasText: /^repo-1main/ }).click();
  await expect(page.locator('.inspector h2')).toHaveText('repo-1');
  await expect(page.getByText('Something went wrong', { exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});
