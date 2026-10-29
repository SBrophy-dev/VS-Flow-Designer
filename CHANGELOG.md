# Changelog

## 0.0.2

Makes flows quicker to read and understand.

- **Clearer connections.** Lines between blocks are drawn with right angles and rounded corners instead of curves. All lines into one block join a single line next to it. All lines are solid; error lines are fainter so the main path stands out.
- **Error branches as labels.** Error branches show as a small "→ Block" label next to their dot instead of a line. Click the label to go to that block. Select a block to see its error lines, or turn on **Error lines** in the toolbar to draw them all.
- **Better Arrange.** Every connection except a loop now points left to right. Blocks in a column are ordered to cross fewer lines, and each block lines up with the branch that leads to it, so the main path runs straight.
- **Trace a path.** Select a block and press **T** to highlight every path that leads to it, or **Shift+T** for everything that can happen after it. The buttons are also in the inspector. Press **Esc** to stop.
- **Key values on blocks.** Block summaries show the most useful value for each block type, for example the attribute being checked, the view and its heading, the task name or the wait time.
- **Hover card.** Hover a block to see its summary, parameters, where each branch goes, its problems and its ID.
- **Labels on lines.** Hover a line to see where it comes from and goes to.
- **Loops marked.** Connections that go back to an earlier block have a ↻ marker, and the block they return to has a ↻ in its header.
- **Open linked flows.** Transfer to flow, Invoke module and Create task blocks have a ↗ button that opens the linked flow, if its file is in the workspace.
- **Outline.** The left panel has an **Outline** tab that lists the flow in the order a contact moves through it. Click a row to go to the block. The block palette is on the **Blocks** tab.
- **Legend.** A legend on the canvas explains the line colors and markers.

## 0.0.1

First preview release for testing.

- Visual designer for Amazon Connect flow JSON files (custom editor that stays in sync with the text document).
- Drag-and-drop editing: move blocks, connect and disconnect branches, add blocks from a palette, duplicate and delete.
- Inspector for parameters, branches, conditions, error branches, start block and designer metadata.
- Live structural checks, search, fit to window and automatic layout.
- Local-first: a Flows view, Import Flow (file or clipboard) and Export Flow for Amazon Connect, with no AWS credentials needed.
- Optional Amazon Connect integration (off until you connect an AWS account): explorer, download, publish, pull and compare, with links stored in `.vscode/connect-flows.json`.
