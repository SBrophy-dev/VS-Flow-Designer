import * as vscode from 'vscode';
import * as os from 'node:os';
import * as path from 'node:path';
import { looksLikeFlow, parseFlow, serializeFlow, validateFlow, type ContactFlow } from './shared/flowModel';
import { FLOW_EDITOR_VIEW_TYPE } from './flowEditorProvider';
import { resolveTargetUri } from './connect/connectCommands';
import type { LinkStore } from './connect/linkStore';

const EXCLUDE = '{**/node_modules/**,**/.git/**,**/.vscode-test/**,**/dist/**,**/out/**,**/.vscode/**}';
const MAX_FILES = 3000;
const MAX_FILE_SIZE = 10 * 1024 * 1024;

export function safeFileName(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120) || 'flow';
}

/** The folder new and imported flows go in, or undefined when no folder is open. */
export async function flowsDirectory(): Promise<vscode.Uri | undefined> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    return undefined;
  }
  const sub = vscode.workspace.getConfiguration('vsFlowDesigner').get<string>('flowsFolder', 'contact-flows');
  const dir = sub ? vscode.Uri.joinPath(folder.uri, sub) : folder.uri;
  await vscode.workspace.fs.createDirectory(dir);
  return dir;
}

export async function uniqueFile(dir: vscode.Uri, baseName: string): Promise<vscode.Uri> {
  const base = safeFileName(baseName);
  let candidate = vscode.Uri.joinPath(dir, `${base}.json`);
  for (let n = 2; await exists(candidate); n++) {
    candidate = vscode.Uri.joinPath(dir, `${base} (${n}).json`);
  }
  return candidate;
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

interface LocalFlow {
  uri: vscode.Uri;
  name: string;
  type?: string;
  blocks: number;
}

/** "Flows" view: every Amazon Connect flow file in the workspace. Works without AWS. */
export class LocalFlowsProvider implements vscode.TreeDataProvider<LocalFlow>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly cache = new Map<string, { mtime: number; flow: LocalFlow | undefined }>();
  private readonly watcher = vscode.workspace.createFileSystemWatcher('**/*.json');
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly links: LinkStore) {
    const later = () => {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.changed.fire(), 400);
    };
    this.watcher.onDidCreate(later);
    this.watcher.onDidDelete(later);
    this.watcher.onDidChange(later);
    links.onDidChange(later);
  }

  dispose(): void {
    this.watcher.dispose();
    this.changed.dispose();
  }

  refresh(): void {
    this.cache.clear();
    this.changed.fire();
  }

  getTreeItem(flow: LocalFlow): vscode.TreeItem {
    const link = this.links.get(flow.uri);
    const item = new vscode.TreeItem(flow.name, vscode.TreeItemCollapsibleState.None);
    item.resourceUri = flow.uri;
    item.iconPath = new vscode.ThemeIcon(link ? 'cloud' : 'type-hierarchy-sub');
    const dir = path.dirname(vscode.workspace.asRelativePath(flow.uri, false));
    item.description = dir === '.' ? undefined : dir;
    item.tooltip = new vscode.MarkdownString(
      [
        `**${flow.name}**`,
        vscode.workspace.asRelativePath(flow.uri),
        `${flow.blocks} blocks${flow.type ? ` · ${flow.type}` : ''}`,
        link ? `Linked to ${link.instanceAlias ?? link.instanceId} (${link.region})` : '',
      ]
        .filter(Boolean)
        .join('\n\n'),
    );
    item.contextValue = link ? 'localFlow.linked' : 'localFlow';
    item.command = { command: 'vscode.openWith', title: 'Open in VS Flow Designer', arguments: [flow.uri, FLOW_EDITOR_VIEW_TYPE] };
    return item;
  }

  async getChildren(element?: LocalFlow): Promise<LocalFlow[]> {
    if (element || !vscode.workspace.workspaceFolders?.length) {
      return [];
    }
    const files = await vscode.workspace.findFiles('**/*.json', EXCLUDE, MAX_FILES);
    const results = await Promise.all(files.map((uri) => this.read(uri)));
    return results.filter((f): f is LocalFlow => !!f).sort((a, b) => a.name.localeCompare(b.name));
  }

  private async read(uri: vscode.Uri): Promise<LocalFlow | undefined> {
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      const cached = this.cache.get(uri.toString());
      if (cached && cached.mtime === stat.mtime) {
        return cached.flow;
      }
      let flow: LocalFlow | undefined;
      if (stat.size <= MAX_FILE_SIZE) {
        const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
        if (text.includes('"Actions"')) {
          const value: unknown = JSON.parse(text);
          if (looksLikeFlow(value)) {
            flow = {
              uri,
              name: value.Metadata?.name || path.basename(uri.fsPath, '.json'),
              type: value.Metadata?.type,
              blocks: value.Actions.length,
            };
          }
        }
      }
      this.cache.set(uri.toString(), { mtime: stat.mtime, flow });
      return flow;
    } catch {
      return undefined;
    }
  }
}

/**
 * Opens the workspace flow file a block points to. A file matches when it is linked to
 * the referenced Amazon Connect flow, or when its file name or flow name equals the
 * reference or the block's display name.
 */
export async function openLinkedFlow(reference: string, name: string | undefined, links: LinkStore): Promise<void> {
  const norm = (value: string) => value.trim().toLowerCase();
  const id = reference.startsWith('arn:') ? reference.split('/').pop()! : reference;
  const wanted = new Set([reference, id, name].filter((v): v is string => !!v).map(norm));
  const matches: { uri: vscode.Uri; name: string }[] = [];
  for (const uri of await vscode.workspace.findFiles('**/*.json', EXCLUDE, MAX_FILES)) {
    const link = links.get(uri);
    const base = path.basename(uri.fsPath, '.json');
    if ((link && (wanted.has(norm(link.flowId)) || (link.flowName && wanted.has(norm(link.flowName))))) || wanted.has(norm(base))) {
      matches.push({ uri, name: link?.flowName ?? base });
      continue;
    }
    try {
      if ((await vscode.workspace.fs.stat(uri)).size > MAX_FILE_SIZE) {
        continue;
      }
      const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
      if (!text.includes('"Actions"')) {
        continue;
      }
      const value: unknown = JSON.parse(text);
      if (looksLikeFlow(value) && value.Metadata?.name && wanted.has(norm(value.Metadata.name))) {
        matches.push({ uri, name: value.Metadata.name });
      }
    } catch {
      // Not readable JSON: not a match.
    }
  }
  const label = name ?? reference;
  if (matches.length === 0) {
    void vscode.window.showInformationMessage(`No flow file for "${label}" was found in this workspace.`);
    return;
  }
  const pick =
    matches.length === 1
      ? matches[0]
      : await vscode.window.showQuickPick(
          matches.map((m) => ({ label: m.name, description: vscode.workspace.asRelativePath(m.uri), match: m })),
          { title: `Several files match "${label}"` },
        ).then((item) => item?.match);
  if (pick) {
    await vscode.commands.executeCommand('vscode.openWith', pick.uri, FLOW_EDITOR_VIEW_TYPE);
  }
}

// ---------------------------------------------------------------------------
// Import / export (local files only, no AWS)

function parseImported(text: string, source: string): ContactFlow | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    void vscode.window.showErrorMessage(`${source} is not valid JSON: ${(e as Error).message}`);
    return undefined;
  }
  if (!looksLikeFlow(value)) {
    const legacy = !!value && typeof value === 'object' && 'modules' in value;
    void vscode.window.showErrorMessage(
      legacy
        ? `${source} uses the old Amazon Connect export format. Open it in the Amazon Connect flow designer, save it, and export it again to get the current format.`
        : `${source} does not contain an Amazon Connect flow. Export the flow from the Amazon Connect flow designer (Save ▸ Export flow) and import that file.`,
    );
    return undefined;
  }
  return value;
}

async function saveImported(flow: ContactFlow, fallbackName: string): Promise<vscode.Uri | undefined> {
  const name = flow.Metadata?.name || fallbackName;
  const dir = await flowsDirectory();
  const target = dir
    ? await uniqueFile(dir, name)
    : await vscode.window.showSaveDialog({
        title: 'Save the imported flow',
        defaultUri: vscode.Uri.file(path.join(os.homedir(), `${safeFileName(name)}.json`)),
        filters: { 'Amazon Connect flow': ['json'] },
      });
  if (target) {
    // Pretty-printed so the file diffs well in source control.
    await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(serializeFlow(flow, '  ')));
  }
  return target;
}

export async function importFlow(): Promise<void> {
  const source = await vscode.window.showQuickPick(
    [
      { label: '$(file) From a file…', description: 'A .json file exported from the Amazon Connect flow designer', value: 'file' },
      { label: '$(clippy) From the clipboard', description: 'Flow JSON you copied', value: 'clipboard' },
    ],
    { title: 'Import an Amazon Connect flow' },
  );
  if (!source) {
    return;
  }
  const imported: vscode.Uri[] = [];
  if (source.value === 'clipboard') {
    const flow = parseImported(await vscode.env.clipboard.readText(), 'The clipboard');
    const uri = flow && (await saveImported(flow, 'Imported flow'));
    if (uri) {
      imported.push(uri);
    }
  } else {
    const files = await vscode.window.showOpenDialog({
      title: 'Import Amazon Connect flows',
      canSelectMany: true,
      filters: { 'Amazon Connect flow': ['json'], 'All files': ['*'] },
      defaultUri: vscode.Uri.file(path.join(os.homedir(), 'Downloads')),
    });
    for (const file of files ?? []) {
      const flow = parseImported(new TextDecoder().decode(await vscode.workspace.fs.readFile(file)), path.basename(file.fsPath));
      if (!flow) {
        continue;
      }
      // A file that is already in the workspace is opened where it is.
      const uri = vscode.workspace.getWorkspaceFolder(file) ? file : await saveImported(flow, path.basename(file.fsPath, '.json'));
      if (uri) {
        imported.push(uri);
      }
    }
  }
  if (imported.length === 0) {
    return;
  }
  await vscode.commands.executeCommand('vscode.openWith', imported[imported.length - 1], FLOW_EDITOR_VIEW_TYPE);
  if (imported.length > 1) {
    void vscode.window.showInformationMessage(`Imported ${imported.length} flows.`);
  }
}

/** Copies the bundled sample into the workspace (never edits the installed copy) and opens it. */
export async function openSampleFlow(extensionUri: vscode.Uri): Promise<void> {
  const sample = vscode.Uri.joinPath(extensionUri, 'samples', 'Sample inbound flow.json');
  const flow = parseImported(new TextDecoder().decode(await vscode.workspace.fs.readFile(sample)), 'The sample flow');
  const uri = flow && (await saveImported(flow, 'Sample inbound flow'));
  if (uri) {
    await vscode.commands.executeCommand('vscode.openWith', uri, FLOW_EDITOR_VIEW_TYPE);
  }
}

async function readFlow(arg: unknown): Promise<{ uri: vscode.Uri; flow: ContactFlow } | undefined> {
  const uri = resolveTargetUri(arg);
  if (!uri) {
    void vscode.window.showWarningMessage('Open an Amazon Connect flow file first.');
    return undefined;
  }
  const document = await vscode.workspace.openTextDocument(uri);
  const parsed = parseFlow(document.getText());
  if (!parsed.flow) {
    void vscode.window.showErrorMessage(`${path.basename(uri.fsPath)}: ${parsed.error}`);
    return undefined;
  }
  return { uri, flow: parsed.flow };
}

async function confirmProblems(flow: ContactFlow, action: string): Promise<boolean> {
  const errors = validateFlow(flow).filter((i) => i.severity === 'error');
  if (errors.length === 0) {
    return true;
  }
  const answer = await vscode.window.showWarningMessage(
    `The flow has ${errors.length} problem(s) that Amazon Connect will probably reject:\n\n${errors.slice(0, 5).map((e) => `• ${e.message}`).join('\n')}`,
    { modal: true },
    `${action} Anyway`,
  );
  return answer === `${action} Anyway`;
}

/** Writes single-line flow JSON, the format the Amazon Connect "Import flow" option expects. */
export async function exportFlow(arg?: unknown): Promise<void> {
  const target = await readFlow(arg);
  if (!target || !(await confirmProblems(target.flow, 'Export'))) {
    return;
  }
  const name = target.flow.Metadata?.name || path.basename(target.uri.fsPath, '.json');
  const downloads = path.join(os.homedir(), 'Downloads');
  const defaultDir = (await exists(vscode.Uri.file(downloads))) ? downloads : path.dirname(target.uri.fsPath);
  const destination = await vscode.window.showSaveDialog({
    title: 'Export flow for Amazon Connect',
    defaultUri: vscode.Uri.file(path.join(defaultDir, `${safeFileName(name)}.json`)),
    filters: { 'Amazon Connect flow': ['json'] },
  });
  if (!destination) {
    return;
  }
  await vscode.workspace.fs.writeFile(destination, new TextEncoder().encode(JSON.stringify(target.flow)));
  const action = await vscode.window.showInformationMessage(
    `Exported "${name}". In the Amazon Connect flow designer, open the flow, choose Save ▸ Import flow, then select this file.`,
    'Reveal File',
  );
  if (action === 'Reveal File') {
    await vscode.commands.executeCommand('revealFileInOS', destination);
  }
}

export async function copyFlowJson(arg?: unknown): Promise<void> {
  const target = await readFlow(arg);
  if (!target) {
    return;
  }
  await vscode.env.clipboard.writeText(JSON.stringify(target.flow));
  void vscode.window.showInformationMessage(`Copied "${target.flow.Metadata?.name || path.basename(target.uri.fsPath)}" to the clipboard.`);
}
