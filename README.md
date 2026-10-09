# git-monitor

A native Tauri desktop application for monitoring local Git repositories on a connected canvas. Repository state and operations come from Git itself. The frontend is packaged inside the application; production builds do not start a local web server.

## What is implemented

- Native folder picker and drag-and-drop, recursive discovery of nested repositories, worktrees, and submodules; multiple monitored roots.
- Persistent canvas positions, layouts, viewport, appearance, and folder preferences.
- File system event monitoring with debounced repository refresh, real branch and changed-file counts, staged and working-tree diffs, staging and unstaging.
- Individual commit, amend of unpublished local commits, push, fetch, and fast-forward-only pull.
- Independent bulk commit/push, fetch, and pull with per-repository results and retry.
- Local branch creation, switch, rename, safe deletion, publication, and recent history.
- GitHub device sign-in with OS credential storage, pull request listing and creation, and the guarded “PR from Different Branch” workflow for uncommitted changes or local commits ahead of `origin/<target>`.

## Architecture

`src/` contains the React/XYFlow canvas and floating inspector. `src-tauri/src/git.rs` performs Git operations with argument-array processes, `github.rs` handles OAuth and GitHub REST calls, and `lib.rs` owns Tauri commands, persistent settings, and native file watchers. Credentials are stored through the OS keyring. Git commands run without a terminal window.

## Installers

The tag-triggered [release workflow](.github/workflows/release.yml) builds:

- `git-monitor-Setup-x64.exe` on Windows (NSIS)
- `git-monitor-macOS-arm64.dmg` on Apple Silicon
- `git-monitor-macOS-x64.dmg` on Intel macOS

All three builds must succeed before the workflow creates a GitHub Release. A local Apple Silicon DMG is available at [`release/git-monitor-macOS-arm64.dmg`](release/git-monitor-macOS-arm64.dmg).

The application uses an installed Git executable and its configured credential helper for remote Git authentication. Local monitoring works without GitHub sign-in. A build without a GitHub OAuth client ID shows a setup error when Connect GitHub is selected.

### Set up GitHub sign-in

1. Open [GitHub Developer settings](https://github.com/settings/developers), choose **OAuth Apps** → **New OAuth App**, and register the app under the account that will maintain it.
2. Set **Application name** to `git-monitor`. Set **Homepage URL** to `https://github.com/Adventnl/git-monitor`. Set **Authorization callback URL** to the same URL; the device flow does not use this callback, but the registration form requires one. Check **Enable Device Flow**. Leave **Expire user access tokens** enabled: the desktop app asks users to reconnect if a token expires or is revoked.
3. Copy the app's **Client ID**. The build needs the client ID only. Do not put a client secret in the desktop app or repository.
4. In this repository, open **Settings** → **Secrets and variables** → **Actions** → **New repository secret**. Name it `GH_OAUTH_CLIENT_ID` and set its value to the client ID. Alternatively, run `gh secret set GH_OAUTH_CLIENT_ID -R Adventnl/git-monitor` and paste the ID at the prompt. Check that its name appears with `gh secret list -R Adventnl/git-monitor`.
5. Build a new installer. The release workflow passes the secret as `GITHUB_CLIENT_ID` at compile time. An installer built before the secret was set must be rebuilt. To publish a version after committing and pushing the source, push a tag that matches the app version (for example, `v0.1.1`); the workflow publishes the installers when all three builds succeed.

See GitHub's [OAuth App registration](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app), [device flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps), and [Actions secrets](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets) documentation.

For macOS Developer ID signing and notarization, set `APPLE_SIGNING_IDENTITY`, `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_ID`, `APPLE_PASSWORD`, and `APPLE_TEAM_ID` as repository secrets. Without these, CI uses an ad-hoc macOS identity and artifacts are not notarized. For Windows signing, set `WINDOWS_CERTIFICATE` (base64 PFX) and `WINDOWS_CERTIFICATE_PASSWORD`. Unsigned Windows builds may show a SmartScreen warning.

## Development

With Node.js, Rust, and Tauri prerequisites installed:

```sh
npm ci
npm run desktop:dev
```

Run `npm run build` for the frontend, `cargo test --manifest-path src-tauri/Cargo.toml --lib` for Git service tests, and `npm run tauri -- build --bundles dmg` on macOS to create a local installer.

## Current limits

GitHub PR operations require the OAuth App client ID. This checkout has no Developer ID credentials; the local DMG uses an ad-hoc app signature and is not notarized. Windows and Intel macOS installers are configured in CI but cannot be verified on this Apple Silicon development machine until their runner jobs complete. Conflict resolution is reported through Git errors and file lists; the app does not yet include a dedicated three-way merge editor. Login start and menu-bar/tray minimization are not yet implemented.
