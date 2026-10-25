import * as vscode from 'vscode';
import type { RemoteLinkInfo } from '../shared/messages';

const LINKS_FILE = '.vscode/connect-flows.json';

interface LinksFile {
  $comment?: string;
  links: Record<string, RemoteLinkInfo>;
}

/**
 * Remembers which Amazon Connect flow each local file came from. Links live in
 * .vscode/connect-flows.json (keyed by workspace-relative path) so a team can commit
 * them; files outside a workspace fall back to the extension's global state.
 */
export class LinkStore implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private cache = new Map<string, LinksFile>();
  private readonly watcher: vscode.FileSystemWatcher;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.watcher = vscode.workspace.createFileSystemWatcher(`**/${LINKS_FILE}`);
    const reload = () => {
      this.cache.clear();
      void this.load().then(() => this.changed.fire());
    };
    this.watcher.onDidChange(reload);
    this.watcher.onDidCreate(reload);
    this.watcher.onDidDelete(reload);
  }

  dispose(): void {
    this.watcher.dispose();
    this.changed.dispose();
  }

  async load(): Promise<void> {
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const uri = vscode.Uri.joinPath(folder.uri, LINKS_FILE);
      try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        const parsed = JSON.parse(new TextDecoder().decode(bytes)) as LinksFile;
        this.cache.set(folder.uri.toString(), { links: parsed.links ?? {} });
      } catch {
        this.cache.set(folder.uri.toString(), { links: {} });
      }
    }
  }

  private locate(uri: vscode.Uri): { folder: vscode.WorkspaceFolder; key: string } | undefined {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder) {
      return undefined;
    }
    const key = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/');
    return { folder, key };
  }

  get(uri: vscode.Uri): RemoteLinkInfo | undefined {
    const location = this.locate(uri);
    if (!location) {
      return this.context.globalState.get<Record<string, RemoteLinkInfo>>('links', {})[uri.toString()];
    }
    return this.cache.get(location.folder.uri.toString())?.links[location.key];
  }

  /** Finds a local file already linked to the given remote flow. */
  findLocal(region: string, instanceId: string, flowId: string): vscode.Uri | undefined {
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const links = this.cache.get(folder.uri.toString())?.links ?? {};
      for (const [path, link] of Object.entries(links)) {
        if (link.region === region && link.instanceId === instanceId && link.flowId === flowId) {
          return vscode.Uri.joinPath(folder.uri, path);
        }
      }
    }
    return undefined;
  }

  async set(uri: vscode.Uri, link: RemoteLinkInfo | undefined): Promise<void> {
    const location = this.locate(uri);
    if (!location) {
      const all = { ...this.context.globalState.get<Record<string, RemoteLinkInfo>>('links', {}) };
      if (link) {
        all[uri.toString()] = link;
      } else {
        delete all[uri.toString()];
      }
      await this.context.globalState.update('links', all);
      this.changed.fire();
      return;
    }
    const folderKey = location.folder.uri.toString();
    if (!this.cache.has(folderKey)) {
      await this.load();
    }
    const file = this.cache.get(folderKey) ?? { links: {} };
    if (link) {
      file.links[location.key] = link;
    } else {
      delete file.links[location.key];
    }
    this.cache.set(folderKey, file);
    const content: LinksFile = {
      $comment: 'Maps local flow files to Amazon Connect flows for VS Flow Designer. Safe to commit.',
      links: Object.fromEntries(Object.entries(file.links).sort(([a], [b]) => a.localeCompare(b))),
    };
    const target = vscode.Uri.joinPath(location.folder.uri, LINKS_FILE);
    await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(JSON.stringify(content, null, 2) + '\n'));
    this.changed.fire();
  }
}
