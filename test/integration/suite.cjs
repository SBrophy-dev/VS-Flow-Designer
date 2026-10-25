// Runs inside the VS Code extension host.
const vscode = require('vscode');
const assert = require('node:assert/strict');
const path = require('node:path');

exports.run = async function run() {
  const ext = vscode.extensions.getExtension('SBrophy-dev.vs-flow-designer');
  assert.ok(ext, 'extension is installed');
  await ext.activate();

  const commands = await vscode.commands.getCommands(true);
  for (const id of ['openDesigner', 'publishFlow', 'downloadFlow', 'compareWithRemote', 'pullFlow', 'newFlow', 'configureAws']) {
    assert.ok(commands.includes(`vsFlowDesigner.${id}`), `command ${id} registered`);
  }

  const sample = vscode.Uri.file(path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, 'Sample inbound flow.json'));
  const document = await vscode.workspace.openTextDocument(sample);
  await vscode.window.showTextDocument(document);
  const lenses = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', sample);
  const lensCommands = lenses.map((l) => l.command && l.command.command);
  assert.ok(lensCommands.includes('vsFlowDesigner.openDesigner'), 'Open CodeLens offered');
  assert.ok(lensCommands.includes('vsFlowDesigner.exportFlow'), 'Export CodeLens offered');
  assert.ok(!lensCommands.includes('vsFlowDesigner.publishFlow'), 'no AWS CodeLens until an account is connected');
  assert.equal(vscode.workspace.getConfiguration('vsFlowDesigner.aws').get('enabled'), false, 'AWS is off by default');

  await vscode.commands.executeCommand('vsFlowDesigner.copyFlowJson', sample);
  const copied = JSON.parse(await vscode.env.clipboard.readText());
  assert.equal(copied.Metadata.name, 'Sample inbound flow', 'flow JSON copied');

  for (const id of ['importFlow', 'exportFlow', 'connectAws', 'disconnectAws', 'refreshLocalFlows', 'openSample']) {
    assert.ok(commands.includes(`vsFlowDesigner.${id}`), `command ${id} registered`);
  }

  await vscode.commands.executeCommand('vsFlowDesigner.openDesigner', sample);
  await new Promise((r) => setTimeout(r, 1500));
  const input = vscode.window.tabGroups.activeTabGroup.activeTab.input;
  assert.ok(input instanceof vscode.TabInputCustom, 'designer tab is open');
  assert.equal(input.viewType, 'vsFlowDesigner.flowEditor');
  assert.equal(document.isDirty, false, 'opening the designer does not modify the file');
  console.log('INTEGRATION OK');
};
