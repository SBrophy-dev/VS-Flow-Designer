import * as vscode from 'vscode';
import * as os from 'node:os';
import * as path from 'node:path';
import { detectIndent, parseFlow, serializeFlow, validateFlow } from '../shared/flowModel';
import type { RemoteLinkInfo } from '../shared/messages';
import { FLOW_EDITOR_VIEW_TYPE, type FlowEditorProvider } from '../flowEditorProvider';
import { ConnectService, awsEnabled, awsSettings, describeAwsError, type InstanceSummary, type RemoteFlowSummary } from './connectService';
import type { LinkStore } from './linkStore';

export const REMOTE_SCHEME = 'vsflow-remote';

export const FLOW_TYPE_LABELS: Record<string, string> = {
  CONTACT_FLOW: 'Inbound flows',
  CUSTOMER_QUEUE: 'Customer queue flows',
  CUSTOMER_HOLD: 'Customer hold flows',
  CUSTOMER_WHISPER: 'Customer whisper flows',
  AGENT_HOLD: 'Agent hold flows',
  AGENT_WHISPER: 'Agent whisper flows',
  OUTBOUND_WHISPER: 'Outbound whisper flows',
  AGENT_TRANSFER: 'Transfer to agent flows',
  QUEUE_TRANSFER: 'Transfer to queue flows',
  CAMPAIGN: 'Campaign flows',
  MODULE: 'Modules',
};

const CONNECT_REGIONS = [
  'us-east-1',
  'us-west-2',
  'ca-central-1',
  'eu-west-2',
  'eu-central-1',
  'ap-southeast-1',
  'ap-southeast-2',
  'ap-northeast-1',
  'ap-northeast-2',
  'af-south-1',
  'us-gov-west-1',
];

/** Read-only documents holding the Amazon Connect side of a "Compare" diff. */
export class RemoteContentProvider implements vscode.TextDocumentContentProvider {
  private readonly contents = new Map<string, string>();
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;

  set(uri: vscode.Uri, content: string): void {
    this.contents.set(uri.toString(), content);
    this.changed.fire(uri);
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.toString()) ?? '';
  }
}

/** The file the user means: an explicit argument, the active designer tab or the active text editor. */
export function resolveTargetUri(arg?: unknown): vscode.Uri | undefined {
  if (arg instanceof vscode.Uri) {
    return arg;
  }
  // Tree items (for example in the Flows view) pass an object with a uri.
  if (arg && typeof arg === 'object' && (arg as { uri?: unknown }).uri instanceof vscode.Uri) {
    return (arg as { uri: vscode.Uri }).uri;
  }
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  if (input instanceof vscode.TabInputCustom || input instanceof vscode.TabInputText) {
    return input.uri;
  }
  return vscode.window.activeTextEditor?.document.uri;
}

function safeFileName(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120) || 'flow';
}

/** Pretty-prints remote content using the indentation of the local file (or two spaces). */
function formatRemote(content: string, likeText?: string): string {
  const parsed = parseFlow(content);
  if (!parsed.flow) {
    return content;
  }
  const indent = likeText !== undefined ? detectIndent(likeText) : '  ';
  return serializeFlow(parsed.flow, likeText === undefined ? '  ' : indent);
}

export class ConnectCommands {
  constructor(
    private readonly service: ConnectService,
    private readonly links: LinkStore,
    private readonly editor: FlowEditorProvider,
    private readonly remoteContent: RemoteContentProvider,
  ) {}

  register(): vscode.Disposable[] {
    const wrap = (fn: (...args: unknown[]) => Promise<unknown>) => async (...args: unknown[]) => {
      try {
        await fn(...args);
      } catch (e) {
        void vscode.window.showErrorMessage(`VS Flow Designer: ${describeAwsError(e)}`);
      }
    };
    // Commands that call AWS first make sure the user has connected an account.
    const online = (fn: (...args: unknown[]) => Promise<unknown>) =>
      wrap(async (...args: unknown[]) => {
        if (await this.ensureConnected()) {
          await fn(...args);
        }
      });
    return [
      vscode.commands.registerCommand('vsFlowDesigner.connectAws', wrap(() => this.configureAws())),
      vscode.commands.registerCommand('vsFlowDesigner.disconnectAws', wrap(() => this.disconnectAws())),
      vscode.commands.registerCommand('vsFlowDesigner.configureAws', wrap(() => this.configureAws())),
      vscode.commands.registerCommand('vsFlowDesigner.downloadFlow', online(() => this.downloadFlow())),
      vscode.commands.registerCommand('vsFlowDesigner.publishFlow', online((uri) => this.publishFlow(resolveTargetUri(uri)))),
      vscode.commands.registerCommand('vsFlowDesigner.pullFlow', online((uri) => this.pullFlow(resolveTargetUri(uri)))),
      vscode.commands.registerCommand('vsFlowDesigner.compareWithRemote', online((uri) => this.compare(resolveTargetUri(uri)))),
      vscode.commands.registerCommand('vsFlowDesigner.unlinkFlow', wrap((uri) => this.unlink(resolveTargetUri(uri)))),
      vscode.commands.registerCommand(
        'vsFlowDesigner.openRemoteFlow',
        online((region, instance, flow) => this.openRemoteFlow(region as string, instance as InstanceSummary, flow as RemoteFlowSummary)),
      ),
    ];
  }

  // -------------------------------------------------------------------------
  // Configuration

  private async ensureConnected(): Promise<boolean> {
    if (awsEnabled()) {
      return true;
    }
    const answer = await vscode.window.showInformationMessage(
      'This needs your AWS account. Connect it now?',
      {
        modal: true,
        detail: 'VS Flow Designer works offline by default. Connecting lets it call Amazon Connect with your local AWS credentials. To use Amazon Connect without credentials, export the flow instead and import it in the Amazon Connect flow designer.',
      },
      'Connect AWS Account…',
    );
    return answer === 'Connect AWS Account…' && (await this.configureAws());
  }

  async disconnectAws(): Promise<void> {
    await vscode.workspace.getConfiguration('vsFlowDesigner.aws').update('enabled', false, vscode.ConfigurationTarget.Global);
    this.service.reset();
    void vscode.window.showInformationMessage('VS Flow Designer is no longer using your AWS account. Import and export still work.');
  }

  async configureAws(): Promise<boolean> {
    const config = vscode.workspace.getConfiguration('vsFlowDesigner.aws');
    const profiles = await readAwsProfiles();
    const current = awsSettings();
    const profilePick = await vscode.window.showQuickPick(
      [
        { label: '$(key) Default credential chain', description: 'AWS_PROFILE, environment variables or the "default" profile', value: '' },
        ...profiles.map((p) => ({ label: p, description: p === current.profile ? 'current' : undefined, value: p })),
      ],
      { title: 'VS Flow Designer: AWS profile', placeHolder: 'Choose the AWS profile used to call Amazon Connect' },
    );
    if (!profilePick) {
      return false;
    }
    const regionPick = await vscode.window.showQuickPick(
      [
        ...CONNECT_REGIONS.map((r) => ({ label: r, description: r === current.region ? 'current' : undefined })),
        { label: '$(edit) Other…', description: 'Type a Region code' },
      ],
      { title: 'VS Flow Designer: AWS Region', placeHolder: 'Choose the Region of your Amazon Connect instance' },
    );
    if (!regionPick) {
      return false;
    }
    let region = regionPick.label;
    if (region.startsWith('$(edit)')) {
      const typed = await vscode.window.showInputBox({ title: 'AWS Region', prompt: 'For example eu-west-2', value: current.region });
      if (!typed) {
        return false;
      }
      region = typed.trim();
    }
    await config.update('profile', profilePick.value, vscode.ConfigurationTarget.Global);
    await config.update('region', region, vscode.ConfigurationTarget.Global);
    await config.update('enabled', true, vscode.ConfigurationTarget.Global);
    this.service.reset();
    void vscode.commands.executeCommand('vsFlowDesigner.refreshExplorer');
    void vscode.window.showInformationMessage(`VS Flow Designer will use ${profilePick.value || 'the default credential chain'} in ${region}.`);
    return true;
  }

  private async region(): Promise<string | undefined> {
    try {
      return await this.service.resolveRegion();
    } catch {
      const configured = await this.configureAws();
      return configured ? this.service.resolveRegion() : undefined;
    }
  }

  // -------------------------------------------------------------------------
  // Picking remote flows

  private async pickInstance(region: string): Promise<InstanceSummary | undefined> {
    const instances = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Listing Amazon Connect instances in ${region}…` },
      () => this.service.listInstances(region),
    );
    if (instances.length === 0) {
      void vscode.window.showWarningMessage(`No Amazon Connect instances were found in ${region}. Check the Region and profile.`);
      return undefined;
    }
    if (instances.length === 1) {
      return instances[0];
    }
    const pick = await vscode.window.showQuickPick(
      instances.map((i) => ({ label: i.alias, description: i.id, instance: i })),
      { title: 'Amazon Connect instance', placeHolder: `Instances in ${region}` },
    );
    return pick?.instance;
  }

  private async pickFlow(region: string, instance: InstanceSummary, title: string): Promise<RemoteFlowSummary | undefined> {
    const flows = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Listing flows in ${instance.alias}…` },
      () => this.service.listFlows(region, instance.id),
    );
    const items: (vscode.QuickPickItem & { flow?: RemoteFlowSummary })[] = [];
    const types = [...new Set(flows.map((f) => f.type))].sort((a, b) => (a === 'CONTACT_FLOW' ? -1 : b === 'CONTACT_FLOW' ? 1 : a.localeCompare(b)));
    for (const type of types) {
      items.push({ label: FLOW_TYPE_LABELS[type] ?? type, kind: vscode.QuickPickItemKind.Separator });
      for (const flow of flows.filter((f) => f.type === type)) {
        items.push({
          label: flow.name,
          description: [flow.status, flow.state === 'ARCHIVED' ? 'archived' : undefined].filter(Boolean).join(' · '),
          detail: flow.id,
          flow,
        });
      }
    }
    const pick = await vscode.window.showQuickPick(items, { title, placeHolder: 'Type to search flows', matchOnDetail: true });
    return pick?.flow;
  }

  // -------------------------------------------------------------------------
  // Download / open

  async downloadFlow(): Promise<void> {
    const region = await this.region();
    if (!region) {
      return;
    }
    const instance = await this.pickInstance(region);
    if (!instance) {
      return;
    }
    const flow = await this.pickFlow(region, instance, 'Download a flow from Amazon Connect');
    if (flow) {
      await this.openRemoteFlow(region, instance, flow);
    }
  }

  async openRemoteFlow(region: string, instance: InstanceSummary, flow: RemoteFlowSummary): Promise<void> {
    const existing = this.links.findLocal(region, instance.id, flow.id);
    if (existing) {
      try {
        await vscode.workspace.fs.stat(existing);
        await vscode.commands.executeCommand('vscode.openWith', existing, FLOW_EDITOR_VIEW_TYPE);
        return;
      } catch {
        // The linked file was deleted; download it again.
      }
    }
    const remote = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Downloading "${flow.name}"…` },
      () => this.service.getFlow(region, instance.id, flow.id, flow.kind),
    );
    const target = existing ?? (await this.chooseDownloadTarget(remote.name));
    if (!target) {
      return;
    }
    await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(formatRemote(remote.content)));
    await this.links.set(target, {
      region,
      instanceId: instance.id,
      instanceAlias: instance.alias,
      flowId: flow.id,
      flowName: remote.name,
      kind: flow.kind,
    });
    await vscode.commands.executeCommand('vscode.openWith', target, FLOW_EDITOR_VIEW_TYPE);
  }

  private async chooseDownloadTarget(name: string): Promise<vscode.Uri | undefined> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    const fileName = `${safeFileName(name)}.json`;
    if (!folder) {
      return vscode.window.showSaveDialog({
        title: 'Save the flow',
        defaultUri: vscode.Uri.file(path.join(os.homedir(), fileName)),
        filters: { 'Amazon Connect flow': ['json'] },
      });
    }
    const subfolder = vscode.workspace.getConfiguration('vsFlowDesigner').get<string>('flowsFolder', 'contact-flows');
    const dir = subfolder ? vscode.Uri.joinPath(folder.uri, subfolder) : folder.uri;
    await vscode.workspace.fs.createDirectory(dir);
    let candidate = vscode.Uri.joinPath(dir, fileName);
    for (let n = 2; await exists(candidate); n++) {
      candidate = vscode.Uri.joinPath(dir, `${safeFileName(name)} (${n}).json`);
    }
    return candidate;
  }

  // -------------------------------------------------------------------------
  // Publish / pull / compare

  private async readFlowDocument(uri: vscode.Uri | undefined): Promise<{ uri: vscode.Uri; document: vscode.TextDocument } | undefined> {
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
    return { uri, document };
  }

  private async linkOrPick(uri: vscode.Uri, purpose: string): Promise<RemoteLinkInfo | undefined> {
    const existing = this.links.get(uri);
    if (existing) {
      return existing;
    }
    const choice = await vscode.window.showInformationMessage(
      `${path.basename(uri.fsPath)} is not linked to a flow in Amazon Connect yet. Choose the flow to ${purpose}.`,
      { modal: true },
      'Choose Flow…',
    );
    if (choice !== 'Choose Flow…') {
      return undefined;
    }
    const region = await this.region();
    if (!region) {
      return undefined;
    }
    const instance = await this.pickInstance(region);
    if (!instance) {
      return undefined;
    }
    const flow = await this.pickFlow(region, instance, `Choose the Amazon Connect flow to ${purpose}`);
    if (!flow) {
      return undefined;
    }
    const link: RemoteLinkInfo = { region, instanceId: instance.id, instanceAlias: instance.alias, flowId: flow.id, flowName: flow.name, kind: flow.kind };
    await this.links.set(uri, link);
    return link;
  }

  async publishFlow(uri: vscode.Uri | undefined): Promise<void> {
    const target = await this.readFlowDocument(uri);
    if (!target) {
      return;
    }
    const { document } = target;
    const flow = parseFlow(document.getText()).flow!;
    const errors = validateFlow(flow).filter((i) => i.severity === 'error');
    if (errors.length) {
      const answer = await vscode.window.showWarningMessage(
        `The flow has ${errors.length} problem(s) that Amazon Connect will probably reject:\n\n${errors.slice(0, 5).map((e) => `• ${e.message}`).join('\n')}`,
        { modal: true },
        'Publish Anyway',
      );
      if (answer !== 'Publish Anyway') {
        return;
      }
    }
    const link = await this.linkOrPick(target.uri, 'publish to');
    if (!link) {
      return;
    }
    const where = `"${link.flowName ?? link.flowId}" in ${link.instanceAlias ?? link.instanceId} (${link.region})`;
    if (vscode.workspace.getConfiguration('vsFlowDesigner').get<boolean>('confirmBeforePublish', true)) {
      const answer = await vscode.window.showWarningMessage(
        `Publish ${path.basename(target.uri.fsPath)} to ${where}?`,
        { modal: true, detail: 'This replaces the live flow in Amazon Connect. Contacts that enter the flow after this will use the new version.' },
        'Publish',
      );
      if (answer !== 'Publish') {
        return;
      }
    }
    if (document.isDirty) {
      await document.save();
    }
    this.editor.setBusy(target.uri, true, 'Publishing…');
    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Publishing to ${where}…` }, () =>
        this.service.publishFlow(link.region, link.instanceId, link.flowId, link.kind, JSON.stringify(flow)),
      );
    } finally {
      this.editor.setBusy(target.uri, false);
    }
    const action = await vscode.window.showInformationMessage(`Published to ${where}.`, 'Compare');
    if (action === 'Compare') {
      await this.compare(target.uri);
    }
  }

  async pullFlow(uri: vscode.Uri | undefined): Promise<void> {
    if (!uri) {
      void vscode.window.showWarningMessage('Open an Amazon Connect flow file first.');
      return;
    }
    const link = await this.linkOrPick(uri, 'pull from');
    if (!link) {
      return;
    }
    const document = await vscode.workspace.openTextDocument(uri);
    this.editor.setBusy(uri, true, 'Pulling…');
    let remote;
    try {
      remote = await this.service.getFlow(link.region, link.instanceId, link.flowId, link.kind);
    } finally {
      this.editor.setBusy(uri, false);
    }
    const text = formatRemote(remote.content, document.getText().trim() ? document.getText() : undefined);
    if (text === document.getText()) {
      void vscode.window.showInformationMessage(`${path.basename(uri.fsPath)} already matches Amazon Connect.`);
      return;
    }
    if (document.getText().trim()) {
      const answer = await vscode.window.showWarningMessage(
        `Replace ${path.basename(uri.fsPath)} with the version in Amazon Connect?`,
        { modal: true, detail: 'Your local changes can be restored with Undo.' },
        'Replace',
        'Compare First',
      );
      if (answer === 'Compare First') {
        await this.compare(uri);
        return;
      }
      if (answer !== 'Replace') {
        return;
      }
    }
    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, new vscode.Range(0, 0, document.lineCount, 0), text);
    await vscode.workspace.applyEdit(edit);
    await document.save();
    if (remote.name !== link.flowName) {
      await this.links.set(uri, { ...link, flowName: remote.name });
    }
  }

  async compare(uri: vscode.Uri | undefined): Promise<void> {
    if (!uri) {
      void vscode.window.showWarningMessage('Open an Amazon Connect flow file first.');
      return;
    }
    const link = await this.linkOrPick(uri, 'compare with');
    if (!link) {
      return;
    }
    const document = await vscode.workspace.openTextDocument(uri);
    this.editor.setBusy(uri, true, 'Fetching from Amazon Connect…');
    let remote;
    try {
      remote = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Fetching flow from Amazon Connect' }, () =>
        this.service.getFlow(link.region, link.instanceId, link.flowId, link.kind),
      );
    } finally {
      this.editor.setBusy(uri, false);
    }
    // Compare like with like: the local side is shown pretty-printed too when it is single-line.
    const localText = document.getText();
    const localIsCompact = detectIndent(localText) === undefined;
    const remoteUri = vscode.Uri.from({ scheme: REMOTE_SCHEME, path: `/${link.flowId}/${safeFileName(remote.name)}.json` });
    this.remoteContent.set(remoteUri, formatRemote(remote.content, localIsCompact ? undefined : localText));
    let leftUri = uri;
    if (localIsCompact) {
      leftUri = vscode.Uri.from({ scheme: REMOTE_SCHEME, path: `/local/${path.basename(uri.fsPath)}` });
      this.remoteContent.set(leftUri, formatRemote(localText));
    }
    await vscode.commands.executeCommand('vscode.diff', remoteUri, leftUri, `${remote.name} (Amazon Connect) ↔ ${path.basename(uri.fsPath)}`);
  }

  async unlink(uri: vscode.Uri | undefined): Promise<void> {
    if (!uri || !this.links.get(uri)) {
      void vscode.window.showInformationMessage('This file is not linked to Amazon Connect.');
      return;
    }
    await this.links.set(uri, undefined);
    void vscode.window.showInformationMessage(`${path.basename(uri.fsPath)} is no longer linked to Amazon Connect.`);
  }
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

/** Profile names from ~/.aws/config and ~/.aws/credentials (or the AWS_* file overrides). */
async function readAwsProfiles(): Promise<string[]> {
  const files = [
    process.env.AWS_CONFIG_FILE ?? path.join(os.homedir(), '.aws', 'config'),
    process.env.AWS_SHARED_CREDENTIALS_FILE ?? path.join(os.homedir(), '.aws', 'credentials'),
  ];
  const names = new Set<string>();
  for (const file of files) {
    try {
      const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.file(file)));
      for (const match of text.matchAll(/^\s*\[\s*(?:profile\s+)?([^\]\s]+)\s*\]/gm)) {
        if (!match[0].includes('sso-session')) {
          names.add(match[1]);
        }
      }
    } catch {
      // Missing files are normal.
    }
  }
  return [...names].sort();
}
