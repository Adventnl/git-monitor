---
name: git-monitor
description: A quiet connected canvas for local Git work.
colors:
  primary: "#347bf4"
  primary-soft: "#e7f0ff"
  canvas: "#f7f9fc"
  surface: "#ffffff"
  surface-muted: "#f8fafc"
  text: "#182334"
  muted: "#6b7890"
  line: "#e2e7ef"
  clean: "#18bf78"
  changed: "#f46d58"
typography:
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, Inter, sans-serif"
    fontSize: "12px"
  node-title:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, Inter, sans-serif"
    fontSize: "11px"
    fontWeight: 650
rounded:
  control: "8px"
  node: "10px"
  inspector: "13px"
spacing:
  tight: "5px"
  regular: "10px"
  section: "16px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.surface}"
    rounded: "{rounded.control}"
    padding: "0 12px"
  repository-node:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.node}"
    width: "170px"
---

# Design System: git-monitor

## Overview

**Creative North Star: "Repository Artboard"**

The canvas is the product's home. Repository nodes are quiet enough to scan in a group, while individual file and Git controls appear in a dismissible inspector. The supplied reference image fixes the light, sparse composition and subtle blue connections.

**Key Characteristics:** compact white nodes, fine blue curves, generous empty canvas, restrained status colors, and controls revealed on demand.

## Colors

The canvas and surfaces remain very light. Blue identifies selection and actions. Green, coral, and warning red appear only for status. The dark appearance setting maps these same roles to deep neutral surfaces.

**The Status Color Rule.** Use a colored dot or file code for state; the entire node never becomes a status badge.

## Typography

The application uses the operating system's sans serif stack. Repository names and section titles carry weight; paths, branch names, and supporting status stay smaller and calmer. Monospace is reserved for diffs.

## Layout

A 186px section sidebar and 43px title area frame the XYFlow canvas. The sidebar filters repositories by named section. The right inspector is 390px wide when there is room and shrinks on narrower windows. It overlays the canvas instead of replacing it. Canvas pan, zoom, and saved node positions remain under the inspector.

## Elevation & Depth

Nodes use a low ambient shadow with a vertical offset. The inspector and dialogs lift more strongly above the canvas. Thin lines separate lists and controls; the canvas itself has almost invisible dots.

## Shapes

Compact controls use 8px corners, nodes use 10px corners, and the inspector uses 13px corners.

## Components

### Repository node

A 170px summary containing only the repository name, branch, changed-file count or Clean, and a small options glyph. Each node represents one selected Git repository.

### Inspector

A floating right panel with changes first, followed by branches, history, and pull requests. The file list and diff share the available vertical space. Commit controls stay near the bottom.

### Buttons and dialogs

Blue primary actions use white text. Quiet secondary actions use neutral surfaces. Bulk operations open a centered confirmation dialog with repository selection and per-repository results.

## Do's and Don'ts

### Do:

- **Do** keep the canvas readable with dozens of repositories.
- **Do** show real Git state and precise operation results.
- **Do** keep detailed Git controls inside an inspector or dialog.

### Don't:

- **Don't** turn the default view into a dashboard of panels and metrics.
- **Don't** let status colors dominate the canvas.
