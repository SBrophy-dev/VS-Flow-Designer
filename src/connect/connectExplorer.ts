import * as vscode from 'vscode';
import { ConnectService, awsEnabled, describeAwsError, type InstanceSummary, type RemoteFlowSummary } from './connectService';
import { FLOW_TYPE_LABELS } from './connectCommands';
import type { LinkStore } from './linkStore';

type Node =
  | { kind: 'instance'; region: string; instance: InstanceSummary }
  | { kind: 'group'; region: string; instance: InstanceSummary; type: string; flows: RemoteFlowSummary[] }
  | { kind: 'flow'; region: string; instance: InstanceSummary; flow: RemoteFlowSummary }
  | { kind: 'message'; label: string; detail?: string; command?: vscode.Command; icon?: string };

/** Activity bar tree: instances → flow types → flows, for the configured profile and Region. */
export class ConnectExplorer implements vscode.TreeDataProvider<Node> {
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private flowCache = new Map<string, Promise<RemoteFlowSummary[]>>();
  view?: vscode.TreeView<Node>;

  constructor(
    private readonly service: ConnectService,
    private readonly links: LinkStore,
  ) {
    links.onDidChange(() => this.changed.fire(undefined));
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('vsFlowDesigner.aws')) {
        this.refresh();
      }
    });
  }

  refresh(): void {
    this.flowCache.clear();
    this.changed.fire(undefined);
  }

  getTreeItem(node: Node): vscode.TreeItem {
    switch (node.kind) {
      case 'instance': {
        const item = new vscode.TreeItem(node.instance.alias, vscode.TreeItemCollapsibleState.Collapsed);
        item.iconPath = new vscode.ThemeIcon('server-environment');
        item.description = node.region;
        item.tooltip = `${node.instance.alias}\n${node.instance.arn ?? node.instance.id}`;
        item.contextValue = 'instance';
        return item;
      }
      case 'group': {
        const item = new vscode.TreeItem(FLOW_TYPE_LABELS[node.type] ?? node.type, vscode.TreeItemCollapsibleState.Collapsed);
        item.iconPath = new vscode.ThemeIcon(node.type === 'MODULE' ? 'symbol-module' : 'folder');
        item.description = String(node.flows.length);
        return item;
      }
      case 'flow': {
        const item = new vscode.TreeItem(node.flow.name, vscode.TreeItemCollapsibleState.None);
        const local = this.links.findLocal(node.region, node.instance.id, node.flow.id);
        item.iconPath = new vscode.ThemeIcon(local ? 'file-code' : 'type-hierarchy-sub');
        item.description = [local ? 'local' : undefined, node.flow.status === 'SAVED' ? 'saved' : undefined, node.flow.state === 'ARCHIVED' ? 'archived' : undefined]
          .filter(Boolean)
          .join(' · ');
        item.tooltip = `${node.flow.name}\n${node.flow.id}${local ? `\n\nLocal file: ${vscode.workspace.asRelativePath(local)}` : '\n\nClick to download and open'}`;
        item.contextValue = 'flow';
        item.command = {
          command: 'vsFlowDesigner.openRemoteFlow',
          title: 'Open Flow',
          arguments: [node.region, node.instance, node.flow],
        };
        return item;
      }
      case 'message': {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
        item.tooltip = node.detail ?? node.label;
        item.command = node.command;
        item.iconPath = new vscode.ThemeIcon(node.icon ?? 'info');
        return item;
      }
    }
  }

  async getChildren(node?: Node): Promise<Node[]> {
    try {
      if (!node) {
        return await this.rootChildren();
      }
      if (node.kind === 'instance') {
        const flows = await this.flows(node.region, node.instance.id);
        if (flows.length === 0) {
          return [{ kind: 'message', label: 'No flows found' }];
        }
        const types = [...new Set(flows.map((f) => f.type))].sort((a, b) => (a === 'CONTACT_FLOW' ? -1 : b === 'CONTACT_FLOW' ? 1 : a.localeCompare(b)));
        return types.map((type) => ({ kind: 'group', region: node.region, instance: node.instance, type, flows: flows.filter((f) => f.type === type) }));
      }
      if (node.kind === 'group') {
        return node.flows.map((flow) => ({ kind: 'flow', region: node.region, instance: node.instance, flow }));
      }
      return [];
    } catch (e) {
      return [
        {
          kind: 'message',
          label: describeAwsError(e),
          detail: String((e as Error)?.message ?? e),
          icon: 'warning',
          command: { command: 'vsFlowDesigner.configureAws', title: 'Configure AWS' },
        },
      ];
    }
  }

  private async rootChildren(): Promise<Node[]> {
    if (!awsEnabled()) {
      // Empty tree: the welcome view offers to connect an account.
      if (this.view) {
        this.view.description = undefined;
      }
      return [];
    }
    let region: string;
    try {
      region = await this.service.resolveRegion();
    } catch {
      // An empty tree shows the welcome view with the "Configure" button.
      if (this.view) {
        this.view.description = undefined;
      }
      return [];
    }
    if (this.view) {
      this.view.description = region;
    }
    const instances = await this.service.listInstances(region);
    if (instances.length === 0) {
      return [
        {
          kind: 'message',
          label: `No Amazon Connect instances in ${region}`,
          command: { command: 'vsFlowDesigner.configureAws', title: 'Configure AWS' },
        },
      ];
    }
    return instances.map((instance) => ({ kind: 'instance', region, instance }));
  }

  private flows(region: string, instanceId: string): Promise<RemoteFlowSummary[]> {
    const key = `${region}|${instanceId}`;
    let promise = this.flowCache.get(key);
    if (!promise) {
      promise = this.service.listFlows(region, instanceId);
      promise.catch(() => this.flowCache.delete(key));
      this.flowCache.set(key, promise);
    }
    return promise;
  }
}
