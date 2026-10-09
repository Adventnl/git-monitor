# Product

<!-- impeccable:product-schema 1 -->

## Platform

adaptive

## Stack

Tauri 2, Rust, React, and TypeScript, confirmed by the user.

## Users

Developers working with multiple local Git repositories who want to inspect changes and complete routine Git work without entering commands.

## Product Purpose

git-monitor discovers local repositories and presents their real branch and working tree state on an interactive canvas. Users inspect diffs and perform individual or bulk Git operations through the desktop interface.

## Positioning

A spatial overview of many independent repositories, with detailed Git controls revealed only when a repository or root folder is opened.

## Operating Context

Runs as a Windows or macOS desktop application. Users choose one or more local folders; each is scanned recursively for Git repositories and worktrees. GitHub connectivity is optional for local monitoring.

## Capabilities and Constraints

- Real Git operations only; no mock repository state or simulated changes.
- Recursive discovery, automatic monitoring, changed file and diff inspection, staging, commits, push, fetch, safe pull, branch management, and bulk operations.
- GitHub PR creation, including moving work from a main branch to a feature branch, must protect user work and report partial failures honestly.
- Persist roots, canvas layout and preferences locally. Store GitHub credentials in OS credential storage.
- Distribute installable Windows and macOS builds through GitHub Releases.

## Brand Commitments

The application is named `git-monitor`. The supplied reference image and brief pin a quiet, light, minimal connected-node canvas with compact floating repository nodes.

## Evidence on Hand

The user's attached four-screen reference image and complete implementation brief. No real customer repositories or signing credentials were provided.

## Product Principles

- Make actual Git state visible at a glance.
- Keep the canvas calm and expose details on demand.
- Preserve local work through every Git workflow.
- Report operation outcomes per repository.
