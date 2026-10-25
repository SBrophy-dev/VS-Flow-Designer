# VS Flow Designer

View and edit Amazon Connect contact flows in VS Code. You do not have to open the Amazon Connect flow designer each time you want to look at or change a flow.

VS Flow Designer opens a flow's JSON file as an interactive diagram. You can move blocks, connect branches, edit parameters and add new blocks.

**You do not need AWS credentials.** Export a flow from the Amazon Connect flow designer, import it into VS Code, edit it, then export it again and import it back into Amazon Connect. If you want to, you can also connect your AWS account to download, compare and publish flows directly.

> VS Flow Designer is a free, community extension. Amazon Web Services does not make or endorse it. "Amazon Connect" and "AWS" are trademarks of Amazon.com, Inc. or its affiliates.

## Features

### Visual flow designer
- **See the whole flow.** Blocks, branches and the entry point are drawn the same way the Amazon Connect designer draws them. It uses the block positions saved in the file. Notes from the Connect designer show too.
- **Edit by dragging.** Move blocks (or a group of blocks with Shift+drag). To connect a branch, drag from its dot to a block. To disconnect it, Alt+click the dot.
- **Add blocks from the palette.** Click a block to add it, or drag it onto the canvas. If a block is selected, the new block is connected to its first open branch.
- **Inspector.** Edit the parameters as JSON, choose the target of each branch, change condition operators and values, add or remove conditions and error branches, and set the start block.
- **Checks as you edit.** You see branches that are not connected, branches that point to missing blocks, a missing start block and blocks that cannot be reached. Click a problem to go to its block.
- **Find, fit and arrange.** Search blocks by name, type, ID or parameter value. Press **F** to fit the flow to the window. Click **Arrange** to lay out the whole flow automatically.
- **Works like a normal file.** The JSON file stays the source of truth. Save, undo/redo, dirty state, Git diffs and hot exit work as they do in the text editor. You can open the JSON side by side and see the diagram update as you type.

### Import and export (no AWS account needed)
- **Flows view** in the activity bar. It lists every contact flow file in your workspace.
- **Import Flow…** copies a file exported from the Amazon Connect flow designer (**Save ▸ Export flow**) into your workspace and opens it. You can also import flow JSON from the clipboard.
- **Export Flow for Amazon Connect…** saves a file that you can import in the Amazon Connect flow designer (**Save ▸ Import flow**). **Copy Flow JSON to Clipboard** is also available.

### Amazon Connect integration (optional)
This is off until you run **VS Flow Designer: Connect AWS Account…**. Until then, the extension makes no calls to AWS. To turn it off again, run **Disconnect AWS Account**.
- **Amazon Connect explorer** in the activity bar. Browse instances, then flows grouped by type (and modules). Click a flow to download and open it.
- **Download** a flow into your workspace (the folder is set by `vsFlowDesigner.flowsFolder`).
- **Publish** the file to Amazon Connect. You confirm first. If Amazon Connect rejects the flow, its validation messages are shown.
- **Compare** your local file with the live flow in a diff editor.
- **Pull** the latest version from Amazon Connect into the file. You can undo this.
- Links between local files and remote flows are kept in `.vscode/connect-flows.json`, so your team can commit them.

## Getting started

1. In the Amazon Connect flow designer, open your flow and choose **Save ▸ Export flow**.
2. In VS Code, open the **VS Flow Designer** view in the activity bar and choose **Import Flow…**. If the file is already in your workspace, use **Open in VS Flow Designer** in the CodeLens at the top of the file instead.
3. Edit the flow, then choose **Export…** in the designer toolbar.
4. In the Amazon Connect flow designer, choose **Save ▸ Import flow**, select the exported file, then save and publish the flow.

To start from scratch, run **VS Flow Designer: New Contact Flow**. If you want to work with your instance directly, run **VS Flow Designer: Connect AWS Account…**.

To look around first, run **VS Flow Designer: Try the Sample Flow**. It copies a sample inbound flow into your workspace and opens it.

### Open flows in the designer by default

Exported flows are ordinary `.json` files, so VS Code opens them in the text editor by default. If you keep your flows in a folder, you can make the designer the default for that folder in your settings:

```json
"workbench.editorAssociations": {
  "**/contact-flows/*.json": "vsFlowDesigner.flowEditor"
}
```

## AWS credentials and permissions (optional)

You need these only if you connect an AWS account. VS Flow Designer uses the standard AWS credential chain: environment variables, the shared `~/.aws/config` and `~/.aws/credentials` files, and IAM Identity Center (SSO) profiles. Choose a profile and Region in the settings, or with the **Configure AWS Profile and Region** command. If you use SSO, run `aws sso login --profile <name>` first.

The identity needs these permissions:

| Feature | IAM actions |
| --- | --- |
| Browse instances | `connect:ListInstances`, `ds:DescribeDirectories` |
| Browse and download flows | `connect:ListContactFlows`, `connect:DescribeContactFlow` |
| Browse and download modules | `connect:ListContactFlowModules`, `connect:DescribeContactFlowModule` |
| Publish | `connect:UpdateContactFlowContent`, `connect:UpdateContactFlowModuleContent` |

Your credentials are used only on your computer to call Amazon Connect. The extension does not collect any telemetry.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `vsFlowDesigner.aws.enabled` | `false` | Uses your AWS account for the Amazon Connect features. The Connect/Disconnect commands set this. |
| `vsFlowDesigner.aws.profile` | *(empty)* | AWS profile to use. Leave it empty to use the default credential chain. |
| `vsFlowDesigner.aws.region` | *(empty)* | Region of your instances, for example `us-east-1`. |
| `vsFlowDesigner.flowsFolder` | `contact-flows` | The workspace folder where downloaded flows are saved. |
| `vsFlowDesigner.jsonFormatting` | `preserve` | How the file is written after a change: `preserve`, `pretty` or `compact`. |
| `vsFlowDesigner.showCodeLens` | `true` | Shows the CodeLens at the top of flow files. |
| `vsFlowDesigner.confirmBeforePublish` | `true` | Asks you to confirm before a flow is published. |

## Keyboard and mouse

| Action | How |
| --- | --- |
| Pan | Drag the canvas, or scroll |
| Zoom | Ctrl+scroll, pinch, the **+** / **−** keys, or double-click the canvas |
| Fit to window (or to the selection) | **F** |
| Select several blocks | Shift+drag on the canvas, or Shift+click |
| Move selected blocks | Drag, or the arrow keys (Shift for bigger steps) |
| Connect / disconnect | Drag from a branch dot to a block / Alt+click the dot |
| Duplicate, delete | Ctrl+D, Delete |
| Undo, redo | Ctrl+Z, Ctrl+Y (the same as in the text editor) |
| Find blocks | Ctrl+F, then Enter for the next match |

## Known limitations

- Most blocks are edited as parameter JSON. Block-specific forms (for example a queue picker) are planned.
- Block names come from the action type. The designer does not show custom block labels.
- Amazon Connect validates the flow fully only when you publish it. The checks in the designer find structure problems, but they do not check whether ARNs, queues or prompts exist.

## Contributing

```bash
npm install
npm run compile   # build dist/extension.js and dist/webview.js
npm test          # unit tests for the flow model
npm run package   # create the .vsix
```

Press F5 in VS Code to start an Extension Development Host with the `samples` folder open.

## License

MIT. See the LICENSE file included with the extension.
