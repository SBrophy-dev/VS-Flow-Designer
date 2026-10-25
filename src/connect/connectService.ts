import * as vscode from 'vscode';
import {
  ConnectClient,
  DescribeContactFlowCommand,
  DescribeContactFlowModuleCommand,
  InvalidContactFlowException,
  InvalidContactFlowModuleException,
  UpdateContactFlowContentCommand,
  UpdateContactFlowModuleContentCommand,
  paginateListContactFlowModules,
  paginateListContactFlows,
  paginateListInstances,
} from '@aws-sdk/client-connect';

export interface InstanceSummary {
  id: string;
  alias: string;
  arn?: string;
}

export interface RemoteFlowSummary {
  id: string;
  name: string;
  kind: 'flow' | 'module';
  /** Flow type such as CONTACT_FLOW or CUSTOMER_QUEUE; "MODULE" for modules. */
  type: string;
  state?: string;
  status?: string;
}

export interface RemoteFlowContent {
  id: string;
  name: string;
  kind: 'flow' | 'module';
  type: string;
  description?: string;
  content: string;
}

/** AWS access is opt-in: nothing calls AWS until the user connects an account. */
export function awsEnabled(): boolean {
  return vscode.workspace.getConfiguration('vsFlowDesigner.aws').get<boolean>('enabled', false);
}

export function awsSettings(): { profile?: string; region?: string } {
  const config = vscode.workspace.getConfiguration('vsFlowDesigner.aws');
  return {
    profile: config.get<string>('profile') || undefined,
    region: config.get<string>('region') || undefined,
  };
}

/** Thin wrapper around the Amazon Connect API, using the standard AWS credential chain. */
export class ConnectService {
  private clients = new Map<string, ConnectClient>();

  constructor() {
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('vsFlowDesigner.aws')) {
        this.reset();
      }
    });
  }

  reset(): void {
    for (const client of this.clients.values()) {
      client.destroy();
    }
    this.clients.clear();
  }

  /** The configured region, or the one AWS_REGION/the profile supplies. */
  async resolveRegion(): Promise<string> {
    const { region } = awsSettings();
    if (region) {
      return region;
    }
    try {
      const resolved = await this.client(undefined).config.region();
      if (resolved) {
        return resolved;
      }
    } catch {
      // Fall through to the error below.
    }
    throw new Error('No AWS Region is configured. Run "VS Flow Designer: Configure AWS Profile and Region".');
  }

  client(region: string | undefined): ConnectClient {
    const { profile } = awsSettings();
    const key = `${profile ?? ''}|${region ?? ''}`;
    let client = this.clients.get(key);
    if (!client) {
      client = new ConnectClient({
        region,
        profile,
        customUserAgent: 'vs-flow-designer',
      });
      this.clients.set(key, client);
    }
    return client;
  }

  async listInstances(region: string): Promise<InstanceSummary[]> {
    const result: InstanceSummary[] = [];
    for await (const page of paginateListInstances({ client: this.client(region) }, {})) {
      for (const i of page.InstanceSummaryList ?? []) {
        if (i.Id) {
          result.push({ id: i.Id, alias: i.InstanceAlias ?? i.Id, arn: i.Arn });
        }
      }
    }
    return result.sort((a, b) => a.alias.localeCompare(b.alias));
  }

  async listFlows(region: string, instanceId: string): Promise<RemoteFlowSummary[]> {
    const client = this.client(region);
    const flows: RemoteFlowSummary[] = [];
    for await (const page of paginateListContactFlows({ client }, { InstanceId: instanceId })) {
      for (const f of page.ContactFlowSummaryList ?? []) {
        if (f.Id) {
          flows.push({
            id: f.Id,
            name: f.Name ?? f.Id,
            kind: 'flow',
            type: f.ContactFlowType ?? 'CONTACT_FLOW',
            state: f.ContactFlowState,
            status: f.ContactFlowStatus,
          });
        }
      }
    }
    try {
      for await (const page of paginateListContactFlowModules({ client }, { InstanceId: instanceId })) {
        for (const m of page.ContactFlowModulesSummaryList ?? []) {
          if (m.Id) {
            flows.push({ id: m.Id, name: m.Name ?? m.Id, kind: 'module', type: 'MODULE', state: m.State });
          }
        }
      }
    } catch {
      // Modules need an extra permission; flows are still useful without them.
    }
    return flows.sort((a, b) => a.name.localeCompare(b.name));
  }

  async getFlow(region: string, instanceId: string, flowId: string, kind: 'flow' | 'module'): Promise<RemoteFlowContent> {
    const client = this.client(region);
    if (kind === 'module') {
      const { ContactFlowModule: m } = await client.send(new DescribeContactFlowModuleCommand({ InstanceId: instanceId, ContactFlowModuleId: flowId }));
      return { id: flowId, name: m?.Name ?? flowId, kind, type: 'MODULE', description: m?.Description, content: m?.Content ?? '' };
    }
    const { ContactFlow: f } = await client.send(new DescribeContactFlowCommand({ InstanceId: instanceId, ContactFlowId: flowId }));
    return { id: flowId, name: f?.Name ?? flowId, kind, type: f?.Type ?? 'CONTACT_FLOW', description: f?.Description, content: f?.Content ?? '' };
  }

  async publishFlow(region: string, instanceId: string, flowId: string, kind: 'flow' | 'module', content: string): Promise<void> {
    const client = this.client(region);
    try {
      if (kind === 'module') {
        await client.send(new UpdateContactFlowModuleContentCommand({ InstanceId: instanceId, ContactFlowModuleId: flowId, Content: content }));
      } else {
        await client.send(new UpdateContactFlowContentCommand({ InstanceId: instanceId, ContactFlowId: flowId, Content: content }));
      }
    } catch (e) {
      if (e instanceof InvalidContactFlowException || e instanceof InvalidContactFlowModuleException) {
        const details = e as { problems?: { message?: string }[]; Problems?: { message?: string }[] };
        const problems = (details.problems ?? details.Problems ?? []).map((p) => p.message).filter(Boolean);
        throw new Error(`Amazon Connect rejected the flow: ${problems.length ? problems.join('; ') : e.message}`);
      }
      throw e;
    }
  }
}

/** Turns AWS SDK errors into messages that tell the user what to do next. */
export function describeAwsError(error: unknown): string {
  const e = error as { name?: string; message?: string; code?: string; hostname?: string };
  const name = e?.name ?? '';
  const host = /connect\.([a-z0-9-]+)\.amazonaws\.com/.exec(e?.hostname ?? e?.message ?? '');
  if ((e?.code === 'ENOTFOUND' || /ENOTFOUND/.test(e?.message ?? '')) && host) {
    return `Could not reach Amazon Connect in ${host[1]}. Amazon Connect may not be available in that Region, or you may be offline. Choose another Region with "Configure AWS Profile and Region".`;
  }
  if (name === 'CredentialsProviderError' || /Could not load credentials|credential/i.test(e?.message ?? '')) {
    return 'No AWS credentials were found. Set a profile with "VS Flow Designer: Configure AWS Profile and Region", or sign in with "aws sso login".';
  }
  if (name === 'ExpiredTokenException' || name === 'ExpiredToken' || /expired/i.test(e?.message ?? '')) {
    return 'Your AWS session has expired. Sign in again (for example with "aws sso login") and retry.';
  }
  if (name === 'AccessDeniedException' || name === 'AccessDenied') {
    return `Access denied by AWS: ${e.message}`;
  }
  return e?.message ?? String(error);
}
