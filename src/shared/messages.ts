// Messages exchanged between the extension host and the designer webview.
import type { ContactFlow } from './flowModel';

export interface RemoteLinkInfo {
  region: string;
  instanceId: string;
  instanceAlias?: string;
  flowId: string;
  flowName?: string;
  kind: 'flow' | 'module';
}

export type HostToWebview =
  | {
      type: 'document';
      text: string;
      fileName: string;
      /** True when the change came from the webview's own edit, so it need not re-render. */
      fromWebview: boolean;
    }
  | { type: 'link'; link: RemoteLinkInfo | undefined }
  /** Whether the user has connected an AWS account (Amazon Connect features are optional). */
  | { type: 'aws'; connected: boolean }
  | { type: 'busy'; busy: boolean; message?: string };

export type WebviewCommand = 'openText' | 'export' | 'import' | 'connect' | 'publish' | 'pull' | 'compare' | 'download';

export type WebviewToHost =
  | { type: 'ready' }
  | { type: 'edit'; flow: ContactFlow; label: string }
  | { type: 'command'; command: WebviewCommand }
  | { type: 'notify'; level: 'info' | 'warning' | 'error'; message: string };
