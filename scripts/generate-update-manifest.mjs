import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const directory = process.argv[2];
if (!directory) throw new Error('Usage: node scripts/generate-update-manifest.mjs <release-directory>');

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const base = `https://github.com/Adventnl/git-monitor/releases/download/v${version}`;
const files = {
  'windows-x86_64': 'git-monitor-Setup-x64.exe',
  'darwin-aarch64': 'git-monitor-macOS-arm64.app.tar.gz',
  'darwin-x86_64': 'git-monitor-macOS-x64.app.tar.gz',
};

const platforms = Object.fromEntries(Object.entries(files).map(([platform, file]) => {
  const archive = join(directory, file);
  if (!statSync(archive).size) throw new Error(`Empty update archive: ${archive}`);
  const signature = readFileSync(`${archive}.sig`, 'utf8').trim();
  if (!signature) throw new Error(`Empty update signature: ${archive}.sig`);
  return [platform, { url: `${base}/${file}`, signature }];
}));

writeFileSync(join(directory, 'latest.json'), `${JSON.stringify({
  version,
  notes: `git-monitor v${version}. See the GitHub release for details.`,
  pub_date: new Date().toISOString(),
  platforms,
}, null, 2)}\n`);
