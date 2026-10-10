# Product

<!-- impeccable:product-schema 1 -->

## Platform

adaptive

## Stack

Tauri 2, Rust, React, and TypeScript, confirmed by the user.

## Users

Developers working with multiple local Git repositories who want to inspect changes and complete routine Git work without entering commands.

## Product Purpose

git-monitor monitors selected local repositories and presents their real branch and working tree state on an interactive canvas. Users inspect diffs and perform individual or bulk Git operations through the desktop interface.

## Positioning

A spatial overview of many independent repositories, with named sidebar sections and detailed Git controls revealed when a repository is opened.

## Operating Context

Runs as a Windows or macOS desktop application. Users select one or more exact Git repository folders and organize them into named sections. GitHub connectivity is optional for local monitoring.

## Capabilities and Constraints

- Real Git operations only; no mock repository state or simulated changes.
- Multi-selection of repository folders, automatic monitoring, named sections, changed file and diff inspection, staging, commits, push, fetch, safe pull, branch management, and bulk operations.
- GitHub PR creation, including moving work from a main branch to a feature branch, must protect user work and report partial failures honestly.
- Persist repository paths, section assignments, canvas layout and preferences locally. Store GitHub credentials in OS credential storage.
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
