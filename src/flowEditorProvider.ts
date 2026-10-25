import * as vscode from 'vscode';
import { detectIndent, serializeFlow } from './shared/flowModel';
import type { HostToWebview, WebviewToHost } from './shared/messages';
import type { LinkStore } from './connect/linkStore';
import { awsEnabled } from './connect/connectService';

export const FLOW_EDITOR_VIEW_TYPE = 'vsFlowDesigner.flowEditor';

/**
 * Custom text editor: the JSON document stays the source of truth, so save, undo/redo,
 * dirty state and source control all behave exactly as they do for the text editor.
 */
export class FlowEditorProvider implements vscode.CustomTextEditorProvider {
  private readonly panels = new Map<string, Set<vscode.WebviewPanel>>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly links: LinkStore,
  ) {
    links.onDidChange(() => {
      for (const [uri, panels] of this.panels) {
        const link = links.get(vscode.Uri.parse(uri));
        for (const panel of panels) {
          post(panel, { type: 'link', link });
        }
      }
    });
  }

  /** Sends a busy indicator to every designer showing the given document. */
  setBusy(uri: vscode.Uri, busy: boolean, message?: string): void {
    for (const panel of this.panels.get(uri.toString()) ?? []) {
      post(panel, { type: 'busy', busy, message });
    }
  }

  async resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): Promise<void> {
    const key = document.uri.toString();
    if (!this.panels.has(key)) {
      this.panels.set(key, new Set());
    }
    this.panels.get(key)!.add(panel);

    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist'), vscode.Uri.joinPath(this.context.extensionUri, 'media')],
    };
    panel.webview.html = this.getHtml(panel.webview);

    // Texts the webview produced itself; a change event carrying one of them is an echo.
    // Edits are applied one at a time so a burst (for example arrow-key nudges) stays in order.
    const pendingSelfEdits: string[] = [];
    let editQueue: Promise<void> = Promise.resolve();

    const sendDocument = (fromWebview: boolean) =>
      post(panel, {
        type: 'document',
        text: document.getText(),
        fileName: vscode.workspace.asRelativePath(document.uri),
        fromWebview,
      });

    const changeSub = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() !== key || e.contentChanges.length === 0) {
        return;
      }
      const text = e.document.getText();
      const index = pendingSelfEdits.indexOf(text);
      if (index >= 0) {
        pendingSelfEdits.splice(0, index + 1);
      } else {
        pendingSelfEdits.length = 0;
      }
      sendDocument(index >= 0);
    });

    const messageSub = panel.webview.onDidReceiveMessage(async (message: WebviewToHost) => {
      switch (message.type) {
        case 'ready':
          sendDocument(false);
          post(panel, { type: 'link', link: this.links.get(document.uri) });
          post(panel, { type: 'aws', connected: awsEnabled() });
          break;
        case 'edit': {
          const { flow, label } = message;
          editQueue = editQueue.then(async () => {
            const text = this.serialize(document, flow);
            if (text === document.getText()) {
              return;
            }
            pendingSelfEdits.push(text);
            const edit = new vscode.WorkspaceEdit();
            edit.replace(document.uri, new vscode.Range(0, 0, document.lineCount, 0), text);
            const applied = await vscode.workspace.applyEdit(edit);
            if (!applied) {
              pendingSelfEdits.length = 0;
              void vscode.window.showErrorMessage(`VS Flow Designer could not apply "${label}".`);
              sendDocument(false);
            }
          }).catch((e: unknown) => {
            // Keep the queue usable after a failure.
            pendingSelfEdits.length = 0;
            void vscode.window.showErrorMessage(`VS Flow Designer could not apply "${label}": ${(e as Error)?.message ?? e}`);
            sendDocument(false);
          });
          await editQueue;
          break;
        }
        case 'command':
          await this.runCommand(message.command, document.uri);
          break;
        case 'notify': {
          const show =
            message.level === 'error'
              ? vscode.window.showErrorMessage
              : message.level === 'warning'
                ? vscode.window.showWarningMessage
                : vscode.window.showInformationMessage;
          show(message.message);
          break;
        }
      }
    });

    const configSub = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('vsFlowDesigner.aws.enabled')) {
        post(panel, { type: 'aws', connected: awsEnabled() });
      }
    });

    panel.onDidDispose(() => {
      configSub.dispose();
      changeSub.dispose();
      messageSub.dispose();
      const set = this.panels.get(key);
      set?.delete(panel);
      if (set?.size === 0) {
        this.panels.delete(key);
      }
    });
  }

  private async runCommand(command: string, uri: vscode.Uri): Promise<void> {
    const map: Record<string, string> = {
      openText: 'vsFlowDesigner.openAsText',
      publish: 'vsFlowDesigner.publishFlow',
      pull: 'vsFlowDesigner.pullFlow',
      compare: 'vsFlowDesigner.compareWithRemote',
      download: 'vsFlowDesigner.downloadFlow',
      export: 'vsFlowDesigner.exportFlow',
      import: 'vsFlowDesigner.importFlow',
      connect: 'vsFlowDesigner.connectAws',
    };
    const id = map[command];
    if (id) {
      await vscode.commands.executeCommand(id, uri);
    }
  }

  private serialize(document: vscode.TextDocument, flow: Parameters<typeof serializeFlow>[0]): string {
    const mode = vscode.workspace.getConfiguration('vsFlowDesigner').get<string>('jsonFormatting', 'preserve');
    const eol = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
    let indent: string | undefined;
    if (mode === 'pretty') {
      indent = detectIndent(document.getText()) ?? '  ';
    } else if (mode === 'compact') {
      indent = undefined;
    } else {
      indent = document.getText().trim() === '' ? '  ' : detectIndent(document.getText());
    }
    return serializeFlow(flow, indent, eol);
  }

  private getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'designer.css'));
    const nonce = createNonce();
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${styleUri}" rel="stylesheet">
  <title>VS Flow Designer</title>
</head>
<body>
  <div id="app"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function post(panel: vscode.WebviewPanel, message: HostToWebview): void {
  void panel.webview.postMessage(message);
}

function createNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let i = 0; i < 32; i++) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}
