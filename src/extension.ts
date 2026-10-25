import * as vscode from 'vscode';
import * as os from 'node:os';
import * as path from 'node:path';
import { FLOW_EDITOR_VIEW_TYPE, FlowEditorProvider } from './flowEditorProvider';
import { LinkStore } from './connect/linkStore';
import { ConnectService, awsEnabled } from './connect/connectService';
import { LocalFlowsProvider, copyFlowJson, exportFlow, flowsDirectory, importFlow, openSampleFlow, safeFileName, uniqueFile } from './localFlows';
import { ConnectCommands, REMOTE_SCHEME, RemoteContentProvider, resolveTargetUri } from './connect/connectCommands';
import { ConnectExplorer } from './connect/connectExplorer';
import { looksLikeFlow, newFlow, serializeFlow } from './shared/flowModel';

const MAX_SNIFF_LENGTH = 20 * 1024 * 1024;

/** Cheap check used for the CodeLens and the editor title button. */
function isFlowDocument(document: vscode.TextDocument): boolean {
  if (document.languageId !== 'json' && document.languageId !== 'jsonc') {
    return false;
  }
  const text = document.getText();
  if (text.length > MAX_SNIFF_LENGTH || !text.includes('"Actions"')) {
    return false;
  }
  try {
    return looksLikeFlow(JSON.parse(text));
  } catch {
    return /"Version"\s*:\s*"20\d\d-\d\d-\d\d"/.test(text) && /"StartAction"/.test(text);
  }
}

class FlowCodeLensProvider implements vscode.CodeLensProvider {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.changed.event;

  constructor(private readonly links: LinkStore) {
    links.onDidChange(() => this.changed.fire());
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('vsFlowDesigner.showCodeLens') || e.affectsConfiguration('vsFlowDesigner.aws.enabled')) {
        this.changed.fire();
      }
    });
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!vscode.workspace.getConfiguration('vsFlowDesigner').get<boolean>('showCodeLens', true) || !isFlowDocument(document)) {
      return [];
    }
    const range = new vscode.Range(0, 0, 0, 0);
    const lenses = [
      new vscode.CodeLens(range, { title: '$(type-hierarchy-sub) Open in VS Flow Designer', command: 'vsFlowDesigner.openDesigner', arguments: [document.uri] }),
      new vscode.CodeLens(range, { title: '$(export) Export for Amazon Connect', command: 'vsFlowDesigner.exportFlow', arguments: [document.uri] }),
    ];
    if (!awsEnabled()) {
      return lenses;
    }
    const link = this.links.get(document.uri);
    lenses.push(
      new vscode.CodeLens(range, {
        title: link ? `$(cloud-upload) Publish to ${link.instanceAlias ?? 'Amazon Connect'}` : '$(cloud-upload) Publish to Amazon Connect…',
        command: 'vsFlowDesigner.publishFlow',
        arguments: [document.uri],
      }),
    );
    if (link) {
      lenses.push(new vscode.CodeLens(range, { title: '$(diff) Compare', command: 'vsFlowDesigner.compareWithRemote', arguments: [document.uri] }));
    }
    return lenses;
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const links = new LinkStore(context);
  await links.load();
  const service = new ConnectService();
  const remoteContent = new RemoteContentProvider();
  const editorProvider = new FlowEditorProvider(context, links);
  const connectCommands = new ConnectCommands(service, links, editorProvider, remoteContent);
  const explorer = new ConnectExplorer(service, links);
  const treeView = vscode.window.createTreeView('vsFlowDesigner.connectExplorer', { treeDataProvider: explorer, showCollapseAll: true });
  explorer.view = treeView;
  const localFlows = new LocalFlowsProvider(links);
  const localView = vscode.window.createTreeView('vsFlowDesigner.localFlows', { treeDataProvider: localFlows });

  const updateContext = () => {
    const document = vscode.window.activeTextEditor?.document;
    void vscode.commands.executeCommand('setContext', 'vsFlowDesigner.activeIsFlow', !!document && isFlowDocument(document));
  };
  updateContext();
  const updateAwsContext = () => void vscode.commands.executeCommand('setContext', 'vsFlowDesigner.awsConnected', awsEnabled());
  updateAwsContext();

  context.subscriptions.push(
    links,
    treeView,
    localFlows,
    localView,
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('vsFlowDesigner.aws.enabled')) {
        updateAwsContext();
      }
    }),
    vscode.commands.registerCommand('vsFlowDesigner.refreshLocalFlows', () => localFlows.refresh()),
    vscode.commands.registerCommand('vsFlowDesigner.importFlow', reportErrors(importFlow)),
    vscode.commands.registerCommand('vsFlowDesigner.exportFlow', reportErrors(exportFlow)),
    vscode.commands.registerCommand('vsFlowDesigner.copyFlowJson', reportErrors(copyFlowJson)),
    vscode.commands.registerCommand('vsFlowDesigner.openSample', reportErrors(() => openSampleFlow(context.extensionUri))),
    vscode.window.registerCustomEditorProvider(FLOW_EDITOR_VIEW_TYPE, editorProvider, {
      webviewOptions: { retainContextWhenHidden: false },
      supportsMultipleEditorsPerDocument: true,
    }),
    vscode.workspace.registerTextDocumentContentProvider(REMOTE_SCHEME, remoteContent),
    vscode.languages.registerCodeLensProvider([{ language: 'json' }, { language: 'jsonc' }], new FlowCodeLensProvider(links)),
    vscode.window.onDidChangeActiveTextEditor(updateContext),
    vscode.workspace.onDidSaveTextDocument((d) => {
      if (d === vscode.window.activeTextEditor?.document) {
        updateContext();
      }
    }),
    ...connectCommands.register(),
    vscode.commands.registerCommand('vsFlowDesigner.refreshExplorer', () => explorer.refresh()),
    vscode.commands.registerCommand('vsFlowDesigner.openDesigner', async (arg?: vscode.Uri) => {
      const uri = resolveTargetUri(arg);
      if (uri) {
        await vscode.commands.executeCommand('vscode.openWith', uri, FLOW_EDITOR_VIEW_TYPE);
      }
    }),
    vscode.commands.registerCommand('vsFlowDesigner.openDesignerToSide', async (arg?: vscode.Uri) => {
      const uri = resolveTargetUri(arg);
      if (uri) {
        await vscode.commands.executeCommand('vscode.openWith', uri, FLOW_EDITOR_VIEW_TYPE, vscode.ViewColumn.Beside);
      }
    }),
    vscode.commands.registerCommand('vsFlowDesigner.openAsText', async (arg?: vscode.Uri) => {
      const uri = resolveTargetUri(arg);
      if (uri) {
        await vscode.commands.executeCommand('vscode.openWith', uri, 'default', vscode.ViewColumn.Beside);
      }
    }),
    vscode.commands.registerCommand('vsFlowDesigner.newFlow', () => createNewFlow()),
  );
}

async function createNewFlow(): Promise<void> {
  const name = await vscode.window.showInputBox({ title: 'New contact flow', prompt: 'Flow name', value: 'New inbound flow' });
  if (!name) {
    return;
  }
  const types = [
    { label: 'Inbound flow', value: 'contactFlow' },
    { label: 'Customer queue flow', value: 'customerQueue' },
    { label: 'Customer hold flow', value: 'customerHold' },
    { label: 'Customer whisper flow', value: 'customerWhisper' },
    { label: 'Agent whisper flow', value: 'agentWhisper' },
    { label: 'Flow module', value: 'contactFlowModule' },
  ];
  const type = await vscode.window.showQuickPick(types, { title: 'Flow type' });
  if (!type) {
    return;
  }
  const dir = await flowsDirectory();
  const target = dir
    ? await uniqueFile(dir, name)
    : await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(path.join(os.homedir(), `${safeFileName(name)}.json`)),
        filters: { 'Amazon Connect flow': ['json'] },
      });
  if (!target) {
    return;
  }
  await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(serializeFlow(newFlow(name, type.value), '  ')));
  await vscode.commands.executeCommand('vscode.openWith', target, FLOW_EDITOR_VIEW_TYPE);
}

function reportErrors(fn: (arg?: unknown) => Promise<void>): (arg?: unknown) => Promise<void> {
  return async (arg) => {
    try {
      await fn(arg);
    } catch (e) {
      void vscode.window.showErrorMessage(`VS Flow Designer: ${(e as Error)?.message ?? e}`);
    }
  };
}

export function deactivate(): void {
  // Nothing to clean up: everything is registered on context.subscriptions.
}
