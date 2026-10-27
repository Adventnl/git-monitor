# git-monitor

A native Tauri desktop application for monitoring local Git repositories on a connected canvas. Repository state and operations come from Git itself. The frontend is packaged inside the application; production builds do not start a local web server.

## What is implemented

- Native multi-folder picker and drag-and-drop for selecting exact Git repositories and worktrees; named sidebar sections for organizing them.
- Persistent repository selections, section assignments, canvas positions, layouts, viewport, and appearance.
- File system event monitoring with debounced repository refresh, real branch and changed-file counts, staged and working-tree diffs, staging and unstaging.
- Individual commit, amend of unpublished local commits, push, fetch, and fast-forward-only pull.
- Independent bulk commit/push, fetch, and pull with per-repository results and retry.
- Local branch creation, switch, rename, safe deletion, publication, and recent history.
- GitHub device sign-in with OS credential storage, pull request listing and creation, and the guarded “PR from Different Branch” workflow for uncommitted changes or local commits ahead of `origin/<target>`.
- Signed in-app updates: git-monitor checks GitHub Releases on launch, offers an install button when a newer version exists, and has a manual check in Settings.

## Architecture

`src/` contains the React/XYFlow canvas and floating inspector. `src-tauri/src/git.rs` performs Git operations with argument-array processes, `github.rs` handles OAuth and GitHub REST calls, and `lib.rs` owns Tauri commands, persistent settings, and native file watchers. Credentials are stored through the OS keyring. Git commands run without a terminal window.

## Installers

### Windows fix in v0.2.1

The v0.2.0 release predates the Windows console-window and repository refresh-loop fixes. v0.2.1 includes them: background Git commands run without console windows, inspections avoid index writes that retrigger monitoring, and repository refreshes share a bounded queue. Running the current source locally does not update an already published installer.

For maintainers, publishing v0.2.1 requires committing the version changes and pushing the `v0.2.1` tag. Running the workflow manually only produces build artifacts; the publish job runs on version tags. Existing v0.2.0 installations can update when the new release is published, or install its Windows setup executable directly.

The tag-triggered [release workflow](.github/workflows/release.yml) builds:

- `git-monitor-Setup-x64.exe` on Windows (NSIS)
- `git-monitor-macOS-arm64.dmg` on Apple Silicon
- `git-monitor-macOS-x64.dmg` on Intel macOS

All three builds must succeed before the workflow creates a GitHub Release. A local Apple Silicon DMG is available at [`release/git-monitor-macOS-arm64.dmg`](release/git-monitor-macOS-arm64.dmg).

Starting with v0.2.0, each release also contains signed updater packages and `latest.json`. The app checks that manifest on launch and verifies the package signature before installing. You can also use **Settings → App updates → Check for updates**. Existing v0.1.1 installations need to install v0.2.0 manually once, because that version has no updater.

Release builds require a `TAURI_SIGNING_PRIVATE_KEY` Actions secret. The matching public key is in `src-tauri/tauri.conf.json`. Keep a secure backup of the private key: future updates must use the same key. The private key is never committed. To make a local signed bundle, set `TAURI_SIGNING_PRIVATE_KEY` to the private key file path or contents before running the Tauri build.

The application uses an installed Git executable and its configured credential helper for remote Git authentication. Local monitoring works without GitHub sign-in. A build without a GitHub OAuth client ID shows a setup error when Connect GitHub is selected.

On Windows, all Git subprocesses use `CREATE_NO_WINDOW` so background checks and Git actions do not open command windows. Background inspection disables optional index writes, ignores read events and temporary Git lock/object events, and shares a queue of at most four repository inspections to prevent refresh storms. Real index and branch changes still trigger refreshes.

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
npm run dev
```

`npm run dev` compiles and opens the native desktop app directly, without creating or downloading an installer. Keep the command running while testing: frontend edits reload in the app, and Rust changes rebuild and restart it. Press Ctrl+C to stop. `npm run desktop:dev` remains an alias. To run only the frontend in a browser, use `npm run frontend:dev`; native Git features require the desktop app.

Run `npm test` (Node.js 22.6 or newer) for refresh queue and selection tests, `npm run build` for the frontend, `cargo test --manifest-path src-tauri/Cargo.toml --lib` for Git service and monitor tests, and `npm run tauri -- build --bundles app,dmg` on macOS to create a local installer and signed updater package.

For browser regression tests, install the test browsers once with `npx playwright install chromium webkit`, then run `npm run test:ui`. These tests cover repeated selection, filtering, keyboard search, bulk operations and file-change bursts across 48 repositories. Native commands are mocked only in the tests; Chromium uses Windows paths and WebKit uses Mac paths and shortcuts. This does not replace testing a packaged app on macOS.

## Current limits

GitHub PR operations require the OAuth App client ID. This checkout has no Developer ID credentials; the local DMG uses an ad-hoc app signature and is not notarized. Windows and Intel macOS installers are configured in CI but cannot be verified on this Apple Silicon development machine until their runner jobs complete. Conflict resolution is reported through Git errors and file lists; the app does not yet include a dedicated three-way merge editor. Login start and menu-bar/tray minimization are not yet implemented.
