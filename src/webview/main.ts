// VS Flow Designer webview: renders the flow on a pan/zoom canvas and turns user
// interactions into whole-flow edits that the extension host writes to the document.
import {
  BLOCKS,
  CATEGORY_COLORS,
  CATEGORY_ORDER,
  getBlockCategory,
  getBlockDefinition,
  getBlockLabel,
} from '../shared/blockCatalog';
import {
  ENTRY_ID,
  NODE_HEADER_HEIGHT,
  NODE_OUTPUT_HEIGHT,
  NODE_SUMMARY_HEIGHT,
  NODE_WIDTH,
  addAction,
  addBranch,
  applyLayout,
  autoLayout,
  createAction,
  deleteActions,
  duplicateActions,
  ensurePositions,
  findAction,
  getOutputs,
  getPosition,
  nodeHeight,
  parseFlow,
  removeBranch,
  setOutputTarget,
  setPosition,
  summarizeAction,
  validateFlow,
  type ContactFlow,
  type FlowAction,
  type FlowIssue,
  type Position,
} from '../shared/flowModel';
import type { HostToWebview, RemoteLinkInfo, WebviewCommand, WebviewToHost } from '../shared/messages';
import { h, s, truncate } from './dom';

interface VsCodeApi {
  postMessage(message: WebviewToHost): void;
  getState(): SavedState | undefined;
  setState(state: SavedState): void;
}

interface SavedState {
  view: { x: number; y: number; zoom: number };
  paletteOpen: boolean;
  inspectorOpen: boolean;
  selection: string[];
}

declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();

const ENTRY_WIDTH = 120;
const ENTRY_HEIGHT = 36;
const MIN_ZOOM = 0.15;
const MAX_ZOOM = 2.5;

const OPERATORS = [
  'Equals',
  'NumberLessThan',
  'NumberLessOrEqualTo',
  'NumberGreaterThan',
  'NumberGreaterOrEqualTo',
  'TextContains',
  'TextStartsWith',
  'TextEndsWith',
];

const COMMON_ERRORS = [
  'NoMatchingError',
  'NoMatchingCondition',
  'InputTimeLimitExceeded',
  'QueueAtCapacity',
  'TimeLimitExceeded',
  'CallFailed',
  'ConnectionTimeLimitExceeded',
  'InvalidPhoneNumber',
];

// ---------------------------------------------------------------------------
// State

const saved = vscode.getState();
const state = {
  flow: undefined as ContactFlow | undefined,
  fileName: '',
  error: undefined as string | undefined,
  notAFlow: false,
  issues: [] as FlowIssue[],
  link: undefined as RemoteLinkInfo | undefined,
  awsConnected: false,
  busy: undefined as string | undefined,
  view: saved?.view ?? { x: 0, y: 0, zoom: 1 },
  hasView: !!saved?.view,
  paletteOpen: saved?.paletteOpen ?? true,
  inspectorOpen: saved?.inspectorOpen ?? true,
  selection: new Set<string>(saved?.selection ?? []),
  selectedEdge: undefined as { from: string; key: string } | undefined,
  search: '',
  searchIndex: -1,
  paletteFilter: '',
  showIssues: false,
  /** Unsaved JSON in the inspector, keyed by "<actionId>:<field>". */
  drafts: new Map<string, string>(),
};

function persist(): void {
  vscode.setState({
    view: state.view,
    paletteOpen: state.paletteOpen,
    inspectorOpen: state.inspectorOpen,
    selection: [...state.selection],
  });
}

function post(message: WebviewToHost): void {
  vscode.postMessage(message);
}

function command(name: WebviewCommand): void {
  post({ type: 'command', command: name });
}

/** Publishes the current flow to the host as one undoable edit. */
function commit(label: string): void {
  if (!state.flow) {
    return;
  }
  state.issues = validateFlow(state.flow);
  render();
  post({ type: 'edit', flow: state.flow, label });
}

// ---------------------------------------------------------------------------
// Static layout

const app = document.getElementById('app')!;
const toolbar = h('div', { class: 'toolbar' });
const palette = h('aside', { class: 'palette' });
const canvas = h('div', { class: 'canvas', tabIndex: 0 });
const world = h('div', { class: 'world' });
const edgesSvg = s('svg', { class: 'edges', width: 1, height: 1 });
const nodesLayer = h('div', { class: 'nodes' });
const marquee = h('div', { class: 'marquee', hidden: true });
const overlay = h('div', { class: 'overlay', hidden: true });
const hint = h('div', { class: 'hint' });
const inspector = h('aside', { class: 'inspector' });
const banner = h('div', { class: 'banner', hidden: true });

edgesSvg.append(
  s(
    'defs',
    {},
    ...(['next', 'condition', 'error', 'selected', 'pending'] as const).map((kind) =>
      s(
        'marker',
        { id: `arrow-${kind}`, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' },
        s('path', { d: 'M 0 0 L 10 5 L 0 10 z', class: `arrow arrow-${kind}` }),
      ),
    ),
  ),
);
world.append(edgesSvg, nodesLayer);
canvas.append(world, marquee, hint, overlay);
app.append(toolbar, banner, h('div', { class: 'main' }, palette, canvas, inspector));

// ---------------------------------------------------------------------------
// Geometry

function positionOf(id: string): Position {
  return (state.flow && getPosition(state.flow, id)) ?? { x: 0, y: 0 };
}

function sizeOf(id: string): { width: number; height: number } {
  if (id === ENTRY_ID) {
    return { width: ENTRY_WIDTH, height: ENTRY_HEIGHT };
  }
  const action = state.flow && findAction(state.flow, id);
  return { width: NODE_WIDTH, height: action ? nodeHeight(action) : 60 };
}

function outputPoint(id: string, index: number): Position {
  const p = positionOf(id);
  if (id === ENTRY_ID) {
    return { x: p.x + ENTRY_WIDTH, y: p.y + ENTRY_HEIGHT / 2 };
  }
  return { x: p.x + NODE_WIDTH, y: p.y + NODE_HEADER_HEIGHT + NODE_SUMMARY_HEIGHT + index * NODE_OUTPUT_HEIGHT + NODE_OUTPUT_HEIGHT / 2 };
}

function inputPoint(id: string): Position {
  const p = positionOf(id);
  return { x: p.x, y: p.y + NODE_HEADER_HEIGHT / 2 };
}

function edgePath(a: Position, b: Position): string {
  const dx = b.x - a.x;
  const bend = dx > 0 ? Math.max(40, dx / 2) : Math.max(80, Math.abs(dx) / 3 + 60);
  return `M ${a.x} ${a.y} C ${a.x + bend} ${a.y}, ${b.x - bend} ${b.y}, ${b.x} ${b.y}`;
}

function toWorld(clientX: number, clientY: number): Position {
  const rect = canvas.getBoundingClientRect();
  return { x: (clientX - rect.left - state.view.x) / state.view.zoom, y: (clientY - rect.top - state.view.y) / state.view.zoom };
}

function applyView(): void {
  world.style.transform = `translate(${state.view.x}px, ${state.view.y}px) scale(${state.view.zoom})`;
  canvas.style.setProperty('--grid-size', `${24 * state.view.zoom}px`);
  canvas.style.backgroundPosition = `${state.view.x}px ${state.view.y}px`;
  const zoomLabel = toolbar.querySelector('.zoom-label');
  if (zoomLabel) {
    zoomLabel.textContent = `${Math.round(state.view.zoom * 100)}%`;
  }
  persist();
}

function zoomAt(clientX: number, clientY: number, factor: number): void {
  const rect = canvas.getBoundingClientRect();
  const before = toWorld(clientX, clientY);
  const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, state.view.zoom * factor));
  state.view.zoom = zoom;
  state.view.x = clientX - rect.left - before.x * zoom;
  state.view.y = clientY - rect.top - before.y * zoom;
  applyView();
}

function zoomCenter(factor: number): void {
  const rect = canvas.getBoundingClientRect();
  zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, factor);
}

function allNodeIds(): string[] {
  return state.flow ? [ENTRY_ID, ...state.flow.Actions.map((a) => a.Identifier)] : [];
}

function fitToScreen(ids = allNodeIds()): void {
  if (ids.length === 0) {
    return;
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const id of ids) {
    const p = positionOf(id);
    const size = sizeOf(id);
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x + size.width);
    maxY = Math.max(maxY, p.y + size.height);
  }
  const rect = canvas.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) {
    return;
  }
  const pad = 48;
  const zoom = Math.min(1.1, Math.max(MIN_ZOOM, Math.min((rect.width - pad * 2) / (maxX - minX), (rect.height - pad * 2) / (maxY - minY))));
  state.view.zoom = zoom;
  state.view.x = (rect.width - (maxX - minX) * zoom) / 2 - minX * zoom;
  state.view.y = (rect.height - (maxY - minY) * zoom) / 2 - minY * zoom;
  applyView();
}

function centerOn(id: string): void {
  const rect = canvas.getBoundingClientRect();
  const p = positionOf(id);
  const size = sizeOf(id);
  state.view.x = rect.width / 2 - (p.x + size.width / 2) * state.view.zoom;
  state.view.y = rect.height / 2 - (p.y + size.height / 2) * state.view.zoom;
  applyView();
}

// ---------------------------------------------------------------------------
// Rendering

function render(): void {
  renderToolbar();
  renderPalette();
  renderCanvas();
  renderInspector();
}

function button(label: string, title: string, onClick: () => void, extra: Record<string, unknown> = {}): HTMLButtonElement {
  return h('button', { class: 'btn', title, onClick, ...extra }, label);
}

function renderToolbar(): void {
  const flow = state.flow;
  const meta = flow?.Metadata;
  const errors = state.issues.filter((i) => i.severity === 'error').length;
  const warnings = state.issues.filter((i) => i.severity === 'warning').length;
  const searchInput = h('input', {
    class: 'search',
    type: 'search',
    placeholder: 'Find blocks…',
    value: state.search,
    onInput: (e: Event) => {
      state.search = (e.target as HTMLInputElement).value;
      state.searchIndex = -1;
      renderCanvas();
    },
    onKeydown: (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        jumpToMatch(e.shiftKey ? -1 : 1);
      } else if (e.key === 'Escape') {
        state.search = '';
        (e.target as HTMLInputElement).value = '';
        renderCanvas();
        canvas.focus();
      }
    },
  });

  const linkBadge = state.awsConnected && state.link
    ? h(
        'span',
        { class: 'link-badge', title: `Linked to ${state.link.kind} ${state.link.flowId} in ${state.link.instanceAlias ?? state.link.instanceId} (${state.link.region})` },
        `☁ ${state.link.instanceAlias ?? state.link.instanceId}`,
      )
    : null;

  toolbar.replaceChildren(
    h(
      'div',
      { class: 'toolbar-group title-group' },
      button('☰', 'Toggle block palette', () => {
        state.paletteOpen = !state.paletteOpen;
        persist();
        renderPalette();
      }),
      h('span', { class: 'flow-name', title: state.fileName }, meta?.name || state.fileName || 'Contact flow'),
      meta?.type ? h('span', { class: 'chip' }, meta.type) : null,
      linkBadge,
      state.busy ? h('span', { class: 'busy' }, h('span', { class: 'spinner' }), state.busy) : null,
    ),
    h(
      'div',
      { class: 'toolbar-group' },
      button('−', 'Zoom out (Ctrl+scroll)', () => zoomCenter(1 / 1.2)),
      h('span', { class: 'zoom-label' }, `${Math.round(state.view.zoom * 100)}%`),
      button('+', 'Zoom in (Ctrl+scroll)', () => zoomCenter(1.2)),
      button('Fit', 'Fit the flow to the window (F)', () => fitToScreen()),
      button('Arrange', 'Automatically arrange all blocks', () => arrange(), { disabled: !flow }),
      searchInput,
      h(
        'button',
        {
          class: `btn issues-btn${errors ? ' has-errors' : warnings ? ' has-warnings' : ''}${state.showIssues ? ' active' : ''}`,
          title: 'Show flow problems',
          disabled: !flow,
          onClick: () => {
            state.showIssues = !state.showIssues;
            if (state.showIssues) {
              state.inspectorOpen = true;
              state.selection.clear();
              state.selectedEdge = undefined;
            }
            render();
          },
        },
        errors || warnings ? `⚠ ${errors + warnings}` : '✓ No problems',
      ),
    ),
    h(
      'div',
      { class: 'toolbar-group' },
      button('{ }', 'Open the flow as JSON text', () => command('openText')),
      button('Export…', 'Save a file you can import in the Amazon Connect flow designer (Save ▸ Import flow)', () => command('export'), {
        class: state.awsConnected ? 'btn' : 'btn primary',
        disabled: !flow,
      }),
      // Amazon Connect actions only appear once the user has connected an AWS account.
      state.awsConnected && state.link ? button('Pull', 'Replace this file with the latest version from Amazon Connect', () => command('pull')) : null,
      state.awsConnected && state.link ? button('Compare', 'Compare this file with the flow in Amazon Connect', () => command('compare')) : null,
      state.awsConnected
        ? button(state.link ? 'Publish' : 'Publish…', state.link ? 'Publish this flow to Amazon Connect' : 'Choose an Amazon Connect flow and publish this file to it', () => command('publish'), {
            class: 'btn primary',
            disabled: !flow,
          })
        : null,
      button('⫶', 'Toggle the inspector panel', () => {
        state.inspectorOpen = !state.inspectorOpen;
        persist();
        renderInspector();
      }),
    ),
  );
}

function renderPalette(): void {
  palette.hidden = !state.paletteOpen;
  if (!state.paletteOpen) {
    return;
  }
  const filter = state.paletteFilter.toLowerCase();
  const groups = CATEGORY_ORDER.map((category) => {
    const items = BLOCKS.filter(
      (b) => b.category === category && !b.hidden && (!filter || b.label.toLowerCase().includes(filter) || b.type.toLowerCase().includes(filter)),
    );
    if (items.length === 0) {
      return null;
    }
    return h(
      'div',
      { class: 'palette-group' },
      h('div', { class: 'palette-heading', style: { color: CATEGORY_COLORS[category] } }, category),
      ...items.map((b) =>
        h(
          'div',
          {
            class: 'palette-item',
            draggable: true,
            title: `${b.description}\n\nClick to add, or drag onto the canvas. (${b.type})`,
            style: { '--cat': CATEGORY_COLORS[category] },
            onDragstart: (e: DragEvent) => {
              e.dataTransfer?.setData('application/x-flow-block', b.type);
              e.dataTransfer!.effectAllowed = 'copy';
            },
            onClick: () => addBlock(b.type),
          },
          h('span', { class: 'palette-dot' }),
          b.label,
        ),
      ),
    );
  });
  const input = h('input', {
    class: 'palette-filter',
    type: 'search',
    placeholder: 'Search blocks…',
    value: state.paletteFilter,
    onInput: (e: Event) => {
      state.paletteFilter = (e.target as HTMLInputElement).value;
      renderPalette();
      const again = palette.querySelector<HTMLInputElement>('.palette-filter');
      again?.focus();
      again?.setSelectionRange(again.value.length, again.value.length);
    },
  });
  palette.replaceChildren(input, h('div', { class: 'palette-list' }, ...groups));
}

function matchesSearch(action: FlowAction): boolean {
  const q = state.search.trim().toLowerCase();
  if (!q) {
    return false;
  }
  const haystack = [action.Identifier, action.Type, getBlockLabel(action.Type), JSON.stringify(action.Parameters ?? {})].join(' ').toLowerCase();
  return haystack.includes(q);
}

function searchMatches(): string[] {
  return state.flow?.Actions.filter(matchesSearch).map((a) => a.Identifier) ?? [];
}

function jumpToMatch(step: number): void {
  const matches = searchMatches();
  if (matches.length === 0) {
    return;
  }
  state.searchIndex = (state.searchIndex + step + matches.length) % matches.length;
  const id = matches[state.searchIndex];
  state.selection = new Set([id]);
  centerOn(id);
  render();
}

function issuesFor(id: string): FlowIssue[] {
  return state.issues.filter((i) => i.actionId === id);
}

function renderCanvas(): void {
  const flow = state.flow;
  overlay.hidden = !!flow;
  banner.hidden = !(flow && state.error);
  if (flow && state.error) {
    banner.replaceChildren(
      h('span', {}, `⚠ ${state.error} The designer is showing the last valid version.`),
      button('Open JSON', 'Open the flow as JSON text to fix it', () => command('openText')),
    );
  }
  if (!flow) {
    overlay.replaceChildren(
      h(
        'div',
        { class: 'overlay-card' },
        h('h2', {}, state.notAFlow ? 'Not an Amazon Connect flow' : state.error ? 'Cannot show this flow' : 'Loading…'),
        state.error ? h('p', {}, state.error) : null,
        state.error ? button('Open as JSON text', 'Reopen this file in the text editor', () => command('openText')) : null,
        state.notAFlow ? button('Import a flow…', 'Import a flow exported from Amazon Connect', () => command('import')) : null,
      ),
    );
    nodesLayer.replaceChildren();
    renderEdges();
    return;
  }

  const searching = state.search.trim() !== '';
  const nodes: HTMLElement[] = [];

  // Sticky notes from the Amazon Connect designer.
  for (const note of flow.Metadata?.Annotations ?? []) {
    if (!note.position) {
      continue;
    }
    nodes.push(
      h(
        'div',
        {
          class: 'annotation',
          title: 'Note (from the Amazon Connect designer)',
          style: {
            left: `${note.position.x}px`,
            top: `${note.position.y}px`,
            width: `${note.size?.width ?? 200}px`,
            minHeight: `${note.size?.height ?? 80}px`,
          },
        },
        String(note.content ?? ''),
      ),
    );
  }

  const entry = positionOf(ENTRY_ID);
  nodes.push(
    h(
      'div',
      {
        class: `node entry${state.selection.has(ENTRY_ID) ? ' selected' : ''}`,
        dataset: { id: ENTRY_ID },
        style: { left: `${entry.x}px`, top: `${entry.y}px`, width: `${ENTRY_WIDTH}px`, height: `${ENTRY_HEIGHT}px` },
      },
      h('span', { class: 'entry-label' }, '▶ Entry'),
      h('span', { class: `port out${flow.StartAction ? ' connected' : ''}`, dataset: { key: 'next' }, title: 'Drag to the first block' }),
    ),
  );

  for (const action of flow.Actions) {
    const id = action.Identifier;
    const p = positionOf(id);
    const category = getBlockCategory(action.Type);
    const nodeIssues = issuesFor(id);
    const worst = nodeIssues.some((i) => i.severity === 'error') ? 'error' : nodeIssues.some((i) => i.severity === 'warning') ? 'warning' : '';
    const summary = summarizeAction(action, flow.Metadata?.ActionMetadata?.[id]);
    const classes = ['node'];
    if (state.selection.has(id)) {
      classes.push('selected');
    }
    if (searching) {
      classes.push(matchesSearch(action) ? 'match' : 'dimmed');
    }
    if (flow.StartAction === id) {
      classes.push('start');
    }
    nodes.push(
      h(
        'div',
        {
          class: classes.join(' '),
          dataset: { id },
          style: { left: `${p.x}px`, top: `${p.y}px`, width: `${NODE_WIDTH}px`, '--cat': CATEGORY_COLORS[category] },
          title: `${getBlockLabel(action.Type)} (${action.Type})\n${id}${nodeIssues.length ? `\n\n${nodeIssues.map((i) => `• ${i.message}`).join('\n')}` : ''}`,
        },
        h('span', { class: 'port in', title: 'Drop a connection here' }),
        h(
          'div',
          { class: 'node-header' },
          h('span', { class: 'node-title' }, getBlockLabel(action.Type)),
          worst ? h('span', { class: `node-badge ${worst}` }, worst === 'error' ? '!' : '⚠') : null,
        ),
        h('div', { class: 'node-summary' }, summary ? truncate(summary, 70) : h('span', { class: 'muted' }, action.Type)),
        h(
          'div',
          { class: 'node-outputs' },
          ...getOutputs(action).map((o) =>
            h(
              'div',
              { class: `node-output ${o.kind}` },
              h('span', { class: 'output-label' }, truncate(o.label, 28)),
              h('span', { class: `port out ${o.kind}${o.target ? ' connected' : ''}`, dataset: { key: o.key }, title: `Drag to connect "${o.label}". Alt+click to disconnect.` }),
            ),
          ),
        ),
      ),
    );
  }
  nodesLayer.replaceChildren(...nodes);
  renderEdges();
  hint.textContent = flow.Actions.length === 0 ? 'Add blocks from the palette, then drag from a branch dot to a block to connect them.' : '';
}

function renderEdges(pending?: { from: Position; to: Position }): void {
  const defs = edgesSvg.querySelector('defs')!;
  const parts: SVGElement[] = [];
  const flow = state.flow;
  if (flow) {
    const ids = new Set(flow.Actions.map((a) => a.Identifier));
    const draw = (from: string, key: string, kind: string, index: number, target: string | undefined) => {
      if (!target || !ids.has(target)) {
        return;
      }
      const selected = state.selectedEdge?.from === from && state.selectedEdge.key === key;
      const d = edgePath(outputPoint(from, index), inputPoint(target));
      const related = state.selection.has(from) || state.selection.has(target);
      parts.push(
        s('path', { d, class: 'edge-hit', dataset: { from, key } }),
        s('path', {
          d,
          class: `edge ${kind}${selected ? ' selected' : ''}${related ? ' related' : ''}`,
          'marker-end': `url(#arrow-${selected ? 'selected' : kind})`,
        }),
      );
    };
    draw(ENTRY_ID, 'next', 'next', 0, flow.StartAction);
    for (const action of flow.Actions) {
      getOutputs(action).forEach((o, i) => draw(action.Identifier, o.key, o.kind, i, o.target));
    }
  }
  if (pending) {
    parts.push(s('path', { d: edgePath(pending.from, pending.to), class: 'edge pending', 'marker-end': 'url(#arrow-pending)' }));
  }
  edgesSvg.replaceChildren(defs, ...parts);
}

/** Moves node elements to their current model positions without a full re-render. */
function updateNodePositions(ids: Iterable<string>): void {
  for (const id of ids) {
    const el = nodesLayer.querySelector<HTMLElement>(`.node[data-id="${CSS.escape(id)}"]`);
    if (el) {
      const p = positionOf(id);
      el.style.left = `${p.x}px`;
      el.style.top = `${p.y}px`;
    }
  }
  renderEdges();
}

// ---------------------------------------------------------------------------
// Inspector

function describeAction(action: FlowAction): string {
  const summary = summarizeAction(action, state.flow?.Metadata?.ActionMetadata?.[action.Identifier]);
  return truncate(`${getBlockLabel(action.Type)}${summary ? ` — ${summary}` : ''}`, 60);
}

function targetSelect(current: string | undefined, exclude: string | undefined, onChange: (target: string | undefined) => void): HTMLSelectElement {
  const flow = state.flow!;
  const select = h(
    'select',
    {
      class: 'target-select',
      onChange: (e: Event) => onChange((e.target as HTMLSelectElement).value || undefined),
    },
    h('option', { value: '' }, '— not connected —'),
    ...flow.Actions.filter((a) => a.Identifier !== exclude).map((a) =>
      h('option', { value: a.Identifier, selected: a.Identifier === current }, `${describeAction(a)}  ·  ${a.Identifier.slice(0, 8)}`),
    ),
  );
  if (current && !findAction(flow, current)) {
    select.append(h('option', { value: current, selected: true }, `⚠ missing block ${current}`));
  }
  return select;
}

function section(title: string, ...children: (Node | null | false | undefined)[]): HTMLElement {
  return h('section', { class: 'insp-section' }, h('h3', {}, title), ...children);
}

function issueList(issues: FlowIssue[], clickable: boolean): HTMLElement {
  if (issues.length === 0) {
    return h('p', { class: 'muted' }, 'No problems found.');
  }
  const order = { error: 0, warning: 1, info: 2 };
  return h(
    'ul',
    { class: 'issue-list' },
    ...[...issues]
      .sort((a, b) => order[a.severity] - order[b.severity])
      .map((issue) => {
        const action = issue.actionId ? findAction(state.flow!, issue.actionId) : undefined;
        return h(
          'li',
          {
            class: `issue ${issue.severity}${clickable && issue.actionId ? ' clickable' : ''}`,
            onClick: () => {
              if (clickable && issue.actionId) {
                state.selection = new Set([issue.actionId]);
                state.showIssues = false;
                centerOn(issue.actionId);
                render();
              }
            },
          },
          h('span', { class: 'issue-icon' }, issue.severity === 'error' ? '⛔' : issue.severity === 'warning' ? '⚠' : 'ℹ'),
          h('span', {}, clickable && action ? h('strong', {}, `${getBlockLabel(action.Type)}: `) : null, issue.message),
        );
      }),
  );
}

function jsonEditor(draftKey: string, value: unknown, onApply: (parsed: unknown) => void, rows = 8): HTMLElement {
  const original = JSON.stringify(value ?? {}, null, 2);
  const draft = state.drafts.get(draftKey);
  const error = h('div', { class: 'json-error', hidden: true });
  const status = h('span', { class: 'muted small' }, draft !== undefined ? 'Unsaved changes' : '');
  const textarea = h('textarea', {
    class: 'json-input',
    rows: Math.min(18, Math.max(rows, original.split('\n').length)),
    spellcheck: false,
    value: draft ?? original,
    onInput: () => {
      state.drafts.set(draftKey, textarea.value);
      status.textContent = 'Unsaved changes';
      error.hidden = true;
    },
    onKeydown: (e: KeyboardEvent) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        apply();
      }
    },
  });
  const apply = () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(textarea.value);
    } catch (e) {
      error.textContent = `Invalid JSON: ${(e as Error).message}`;
      error.hidden = false;
      return;
    }
    state.drafts.delete(draftKey);
    onApply(parsed);
  };
  return h(
    'div',
    { class: 'json-editor' },
    textarea,
    error,
    h(
      'div',
      { class: 'row' },
      button('Apply', 'Apply the JSON (Ctrl+Enter)', apply, { class: 'btn primary small' }),
      button('Revert', 'Discard unsaved changes', () => {
        state.drafts.delete(draftKey);
        renderInspector();
      }, { class: 'btn small' }),
      status,
    ),
  );
}

function renderInspector(): void {
  inspector.hidden = !state.inspectorOpen;
  if (!state.inspectorOpen) {
    return;
  }
  const flow = state.flow;
  if (!flow) {
    inspector.replaceChildren();
    return;
  }
  const scroll = inspector.scrollTop;
  const ids = [...state.selection].filter((id) => id === ENTRY_ID || findAction(flow, id));

  let content: (Node | null)[];
  if (state.showIssues) {
    content = [h('h2', {}, 'Problems'), issueList(state.issues, true)];
  } else if (state.selectedEdge) {
    content = renderEdgeInspector(flow, state.selectedEdge);
  } else if (ids.length === 1 && ids[0] === ENTRY_ID) {
    content = [
      h('h2', {}, 'Entry point'),
      section(
        'Start block',
        h('p', { class: 'muted' }, 'The first block that runs when a contact enters this flow.'),
        targetSelect(flow.StartAction, undefined, (target) => {
          setOutputTarget(flow, ENTRY_ID, 'next', target);
          commit('Set start block');
        }),
      ),
    ];
  } else if (ids.length === 1) {
    content = renderActionInspector(flow, findAction(flow, ids[0])!);
  } else if (ids.length > 1) {
    content = [
      h('h2', {}, `${ids.length} blocks selected`),
      h(
        'div',
        { class: 'row' },
        button('Duplicate', 'Duplicate the selected blocks (Ctrl+D)', duplicateSelection),
        button('Delete', 'Delete the selected blocks (Delete)', deleteSelection, { class: 'btn danger' }),
      ),
    ];
  } else {
    content = renderFlowInspector(flow);
  }
  inspector.replaceChildren(...content.filter((c): c is Node => !!c));
  inspector.scrollTop = scroll;
}

function renderFlowInspector(flow: ContactFlow): (Node | null)[] {
  const meta = (flow.Metadata ??= {});
  const textField = (label: string, key: 'name' | 'description', multiline: boolean) => {
    const attrs = {
      class: 'text-input',
      value: String(meta[key] ?? ''),
      onChange: (e: Event) => {
        meta[key] = (e.target as HTMLInputElement).value;
        commit(`Change flow ${key}`);
      },
    };
    return h('label', { class: 'field' }, h('span', {}, label), multiline ? h('textarea', { ...attrs, rows: 3 }) : h('input', attrs));
  };
  const counts = new Map<string, number>();
  for (const action of flow.Actions) {
    counts.set(action.Type, (counts.get(action.Type) ?? 0) + 1);
  }
  return [
    h('h2', {}, 'Flow'),
    section(
      'Details',
      textField('Name', 'name', false),
      textField('Description', 'description', true),
      h(
        'dl',
        { class: 'facts' },
        h('dt', {}, 'Type'),
        h('dd', {}, String(meta.type ?? 'contactFlow')),
        h('dt', {}, 'Version'),
        h('dd', {}, flow.Version),
        h('dt', {}, 'Blocks'),
        h('dd', {}, String(flow.Actions.length)),
        state.awsConnected && state.link ? h('dt', {}, 'Amazon Connect') : null,
        state.awsConnected && state.link ? h('dd', {}, `${state.link.instanceAlias ?? state.link.instanceId} · ${state.link.region}`) : null,
      ),
    ),
    section(
      'Start block',
      targetSelect(flow.StartAction, undefined, (target) => {
        setOutputTarget(flow, ENTRY_ID, 'next', target);
        commit('Set start block');
      }),
    ),
    section('Problems', issueList(state.issues, true)),
    section(
      'Block types',
      h(
        'ul',
        { class: 'type-list' },
        ...[...counts.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([type, n]) => h('li', {}, h('span', { class: 'palette-dot', style: { '--cat': CATEGORY_COLORS[getBlockCategory(type)] } }), `${getBlockLabel(type)}`, h('span', { class: 'muted count' }, `× ${n}`))),
      ),
    ),
    section(
      'Tips',
      h(
        'ul',
        { class: 'tips' },
        h('li', {}, 'Drag a branch dot onto a block to connect it. Alt+click a dot to disconnect.'),
        h('li', {}, 'Shift+drag on the canvas to select several blocks.'),
        h('li', {}, 'Scroll to pan, Ctrl+scroll to zoom, F to fit.'),
        h('li', {}, 'Ctrl+D duplicates, Delete removes, Ctrl+Z undoes.'),
      ),
    ),
  ];
}

function renderEdgeInspector(flow: ContactFlow, edge: { from: string; key: string }): (Node | null)[] {
  const fromAction = edge.from === ENTRY_ID ? undefined : findAction(flow, edge.from);
  const output = fromAction ? getOutputs(fromAction).find((o) => o.key === edge.key) : undefined;
  const target = edge.from === ENTRY_ID ? flow.StartAction : output?.target;
  const targetAction = target ? findAction(flow, target) : undefined;
  return [
    h('h2', {}, 'Connection'),
    h(
      'dl',
      { class: 'facts' },
      h('dt', {}, 'From'),
      h('dd', {}, fromAction ? `${describeAction(fromAction)} → ${output?.label ?? ''}` : 'Entry point'),
      h('dt', {}, 'To'),
      h('dd', {}, targetAction ? describeAction(targetAction) : (target ?? '')),
    ),
    h(
      'div',
      { class: 'row' },
      button('Delete connection', 'Remove this connection (Delete)', () => {
        setOutputTarget(flow, edge.from, edge.key, undefined);
        state.selectedEdge = undefined;
        commit('Disconnect');
      }, { class: 'btn danger' }),
    ),
  ];
}

function renderActionInspector(flow: ContactFlow, action: FlowAction): (Node | null)[] {
  const id = action.Identifier;
  const def = getBlockDefinition(action.Type);
  const category = getBlockCategory(action.Type);
  const outputs = getOutputs(action);
  const t = (action.Transitions ??= {});

  const branchRows = outputs.map((o) => {
    const [kind, indexText] = o.key.split(':');
    const index = Number(indexText);
    const condition = kind === 'condition' ? t.Conditions?.[index] : undefined;
    const error = kind === 'error' ? t.Errors?.[index] : undefined;
    return h(
      'div',
      { class: `branch ${o.kind}` },
      h(
        'div',
        { class: 'branch-head' },
        h('span', { class: `branch-kind ${o.kind}` }, o.kind === 'next' ? 'Success' : o.kind === 'condition' ? 'Condition' : 'Error'),
        condition
          ? h(
              'span',
              { class: 'branch-edit' },
              h(
                'select',
                {
                  class: 'operator-select',
                  onChange: (e: Event) => {
                    condition.Condition.Operator = (e.target as HTMLSelectElement).value;
                    commit('Change condition');
                  },
                },
                ...[...new Set([...OPERATORS, condition.Condition.Operator])].map((op) => h('option', { value: op, selected: op === condition.Condition.Operator }, op)),
              ),
              h('input', {
                class: 'text-input operand-input',
                value: (condition.Condition.Operands ?? []).join(', '),
                title: 'Value to compare (separate several values with commas)',
                onChange: (e: Event) => {
                  condition.Condition.Operands = (e.target as HTMLInputElement).value.split(',').map((v) => v.trim());
                  commit('Change condition');
                },
              }),
            )
          : error
            ? h('input', {
                class: 'text-input operand-input',
                value: error.ErrorType,
                title: 'Error type',
                onChange: (e: Event) => {
                  error.ErrorType = (e.target as HTMLInputElement).value.trim();
                  commit('Change error type');
                },
              })
            : null,
        o.kind !== 'next' || !def?.hasNext
          ? h(
              'button',
              {
                class: 'icon-btn',
                title: 'Remove this branch',
                onClick: () => {
                  removeBranch(flow, id, o.key);
                  commit('Remove branch');
                },
              },
              '✕',
            )
          : null,
      ),
      targetSelect(o.target, id, (target) => {
        setOutputTarget(flow, id, o.key, target);
        commit('Connect');
      }),
    );
  });

  const conditionInput = h('input', { class: 'text-input', placeholder: 'Value, e.g. 3' });
  const errorSelect = h('select', {}, ...COMMON_ERRORS.map((e) => h('option', { value: e }, e)));
  const hasNext = t.NextAction !== undefined || def?.hasNext;

  return [
    h(
      'div',
      { class: 'insp-title', style: { '--cat': CATEGORY_COLORS[category] } },
      h('h2', {}, getBlockLabel(action.Type)),
      h('div', { class: 'muted small' }, `${category} · ${action.Type}`),
      def ? h('p', { class: 'muted' }, def.description) : null,
    ),
    h(
      'div',
      { class: 'id-row' },
      h('code', { title: 'Block identifier' }, id),
      button('Copy', 'Copy the identifier', () => void navigator.clipboard?.writeText(id), { class: 'btn small' }),
    ),
    h(
      'div',
      { class: 'row' },
      flow.StartAction === id
        ? h('span', { class: 'chip' }, 'Start block')
        : button('Set as start', 'Make this the first block of the flow', () => {
            flow.StartAction = id;
            commit('Set start block');
          }, { class: 'btn small' }),
      button('Duplicate', 'Duplicate (Ctrl+D)', duplicateSelection, { class: 'btn small' }),
      button('Delete', 'Delete (Delete)', deleteSelection, { class: 'btn small danger' }),
    ),
    issuesFor(id).length ? section('Problems', issueList(issuesFor(id), false)) : null,
    section(
      'Parameters',
      jsonEditor(`${id}:params`, action.Parameters, (parsed) => {
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          post({ type: 'notify', level: 'error', message: 'Parameters must be a JSON object.' });
          return;
        }
        action.Parameters = parsed as Record<string, unknown>;
        commit('Edit parameters');
      }),
    ),
    section(
      'Branches',
      ...branchRows,
      h(
        'div',
        { class: 'add-branch' },
        !hasNext
          ? button('+ Success', 'Add a default (success) branch', () => {
              t.NextAction = '';
              commit('Add branch');
            }, { class: 'btn small' })
          : null,
        h('div', { class: 'row' }, conditionInput, button('+ Condition', 'Add a condition branch', () => {
          addBranch(flow, id, 'condition', conditionInput.value.trim());
          commit('Add condition');
        }, { class: 'btn small' })),
        h('div', { class: 'row' }, errorSelect, button('+ Error', 'Add an error branch', () => {
          addBranch(flow, id, 'error', errorSelect.value);
          commit('Add error branch');
        }, { class: 'btn small' })),
      ),
    ),
    h(
      'details',
      { class: 'insp-section' },
      h('summary', {}, 'Designer metadata'),
      h('p', { class: 'muted small' }, 'Position and display names stored by the Amazon Connect designer (Metadata.ActionMetadata).'),
      jsonEditor(`${id}:meta`, flow.Metadata?.ActionMetadata?.[id] ?? {}, (parsed) => {
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          post({ type: 'notify', level: 'error', message: 'Metadata must be a JSON object.' });
          return;
        }
        flow.Metadata ??= {};
        flow.Metadata.ActionMetadata ??= {};
        flow.Metadata.ActionMetadata[id] = parsed as Record<string, unknown>;
        commit('Edit block metadata');
      }, 4),
    ),
  ];
}

// ---------------------------------------------------------------------------
// Commands

function arrange(): void {
  if (!state.flow) {
    return;
  }
  applyLayout(state.flow, autoLayout(state.flow));
  commit('Arrange blocks');
  fitToScreen();
}

function freeSpotNear(p: Position): Position {
  const flow = state.flow!;
  const spot = { ...p };
  for (let attempt = 0; attempt < 30; attempt++) {
    const overlaps = flow.Actions.some((a) => {
      const q = positionOf(a.Identifier);
      return Math.abs(q.x - spot.x) < NODE_WIDTH * 0.6 && Math.abs(q.y - spot.y) < 50;
    });
    if (!overlaps) {
      break;
    }
    spot.x += 30;
    spot.y += 30;
  }
  return spot;
}

function addBlock(type: string, at?: Position): void {
  const flow = state.flow;
  if (!flow) {
    return;
  }
  let position = at;
  if (!position) {
    const rect = canvas.getBoundingClientRect();
    const center = toWorld(rect.left + rect.width / 2, rect.top + rect.height / 3);
    position = freeSpotNear({ x: center.x - NODE_WIDTH / 2, y: center.y });
  }
  const action = createAction(type);
  addAction(flow, action, position);
  // Connect the selected block's first open branch to the new block, when there is one.
  if (state.selection.size === 1) {
    const from = [...state.selection][0];
    if (from === ENTRY_ID && !flow.StartAction) {
      flow.StartAction = action.Identifier;
    } else {
      const source = findAction(flow, from);
      const open = source && getOutputs(source).find((o) => !o.target);
      if (source && open) {
        setOutputTarget(flow, from, open.key, action.Identifier);
      }
    }
  }
  state.selection = new Set([action.Identifier]);
  state.selectedEdge = undefined;
  state.showIssues = false;
  commit(`Add ${getBlockLabel(type)}`);
}

function deleteSelection(): void {
  const flow = state.flow;
  if (!flow) {
    return;
  }
  if (state.selectedEdge) {
    setOutputTarget(flow, state.selectedEdge.from, state.selectedEdge.key, undefined);
    state.selectedEdge = undefined;
    commit('Disconnect');
    return;
  }
  const ids = [...state.selection].filter((id) => id !== ENTRY_ID);
  if (ids.length === 0) {
    return;
  }
  deleteActions(flow, ids);
  state.selection.clear();
  commit(ids.length === 1 ? 'Delete block' : `Delete ${ids.length} blocks`);
}

function duplicateSelection(): void {
  const flow = state.flow;
  if (!flow) {
    return;
  }
  const ids = [...state.selection].filter((id) => id !== ENTRY_ID);
  if (ids.length === 0) {
    return;
  }
  state.selection = new Set(duplicateActions(flow, ids));
  commit(ids.length === 1 ? 'Duplicate block' : `Duplicate ${ids.length} blocks`);
}

// ---------------------------------------------------------------------------
// Pointer interaction

type Drag =
  | { kind: 'pan'; startX: number; startY: number; viewX: number; viewY: number; moved: boolean }
  | { kind: 'move'; start: Position; origins: Map<string, Position>; moved: boolean }
  | { kind: 'connect'; from: string; key: string; index: number }
  | { kind: 'marquee'; start: Position; additive: Set<string> };

let drag: Drag | undefined;

canvas.addEventListener('pointerdown', (e) => {
  if (!state.flow || (e.button !== 0 && e.button !== 1)) {
    return;
  }
  const target = e.target as HTMLElement;
  canvas.focus();

  const port = target.closest<HTMLElement>('.port.out');
  const nodeEl = target.closest<HTMLElement>('.node');
  if (port && nodeEl) {
    const from = nodeEl.dataset.id!;
    const key = port.dataset.key!;
    if (e.altKey) {
      setOutputTarget(state.flow, from, key, undefined);
      commit('Disconnect');
      return;
    }
    const index = from === ENTRY_ID ? 0 : getOutputs(findAction(state.flow, from)!).findIndex((o) => o.key === key);
    drag = { kind: 'connect', from, key, index };
    canvas.setPointerCapture(e.pointerId);
    e.preventDefault();
    return;
  }

  const edgeEl = target.closest<SVGPathElement>('.edge-hit');
  if (edgeEl) {
    state.selectedEdge = { from: edgeEl.dataset.from!, key: edgeEl.dataset.key! };
    state.selection.clear();
    state.showIssues = false;
    renderCanvas();
    renderInspector();
    return;
  }

  if (nodeEl && e.button === 0) {
    const id = nodeEl.dataset.id!;
    if (e.shiftKey || e.ctrlKey || e.metaKey) {
      if (state.selection.has(id)) {
        state.selection.delete(id);
      } else {
        state.selection.add(id);
      }
    } else if (!state.selection.has(id)) {
      state.selection = new Set([id]);
    }
    state.selectedEdge = undefined;
    state.showIssues = false;
    const origins = new Map<string, Position>();
    for (const sid of state.selection) {
      origins.set(sid, { ...positionOf(sid) });
    }
    drag = { kind: 'move', start: toWorld(e.clientX, e.clientY), origins, moved: false };
    canvas.setPointerCapture(e.pointerId);
    renderCanvas();
    renderInspector();
    persist();
    return;
  }

  if (e.shiftKey && e.button === 0) {
    drag = { kind: 'marquee', start: toWorld(e.clientX, e.clientY), additive: new Set(state.selection) };
  } else {
    drag = { kind: 'pan', startX: e.clientX, startY: e.clientY, viewX: state.view.x, viewY: state.view.y, moved: false };
    canvas.classList.add('panning');
  }
  canvas.setPointerCapture(e.pointerId);
});

canvas.addEventListener('pointermove', (e) => {
  if (!drag || !state.flow) {
    return;
  }
  if (drag.kind === 'pan') {
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (Math.abs(dx) + Math.abs(dy) > 3) {
      drag.moved = true;
    }
    state.view.x = drag.viewX + dx;
    state.view.y = drag.viewY + dy;
    applyView();
  } else if (drag.kind === 'move') {
    const p = toWorld(e.clientX, e.clientY);
    const dx = p.x - drag.start.x;
    const dy = p.y - drag.start.y;
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 3 / state.view.zoom) {
      return;
    }
    drag.moved = true;
    for (const [id, origin] of drag.origins) {
      setPosition(state.flow, id, { x: origin.x + dx, y: origin.y + dy });
    }
    updateNodePositions(drag.origins.keys());
  } else if (drag.kind === 'connect') {
    renderEdges({ from: outputPoint(drag.from, drag.index), to: toWorld(e.clientX, e.clientY) });
    nodesLayer.querySelectorAll('.drop-target').forEach((el) => el.classList.remove('drop-target'));
    const over = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('.node:not(.entry)');
    if (over && over.dataset.id !== drag.from) {
      over.classList.add('drop-target');
    }
  } else if (drag.kind === 'marquee') {
    const p = toWorld(e.clientX, e.clientY);
    const x1 = Math.min(p.x, drag.start.x);
    const y1 = Math.min(p.y, drag.start.y);
    const x2 = Math.max(p.x, drag.start.x);
    const y2 = Math.max(p.y, drag.start.y);
    const toScreen = (q: Position) => ({ x: q.x * state.view.zoom + state.view.x, y: q.y * state.view.zoom + state.view.y });
    const a = toScreen({ x: x1, y: y1 });
    const b = toScreen({ x: x2, y: y2 });
    Object.assign(marquee.style, { left: `${a.x}px`, top: `${a.y}px`, width: `${b.x - a.x}px`, height: `${b.y - a.y}px` });
    marquee.hidden = false;
    const selection = new Set(drag.additive);
    for (const id of allNodeIds()) {
      const q = positionOf(id);
      const size = sizeOf(id);
      if (q.x < x2 && q.x + size.width > x1 && q.y < y2 && q.y + size.height > y1) {
        selection.add(id);
      }
    }
    state.selection = selection;
    for (const el of nodesLayer.querySelectorAll<HTMLElement>('.node')) {
      el.classList.toggle('selected', selection.has(el.dataset.id!));
    }
  }
});

function endDrag(e: PointerEvent): void {
  const current = drag;
  drag = undefined;
  canvas.classList.remove('panning');
  if (!current || !state.flow) {
    return;
  }
  if (canvas.hasPointerCapture(e.pointerId)) {
    canvas.releasePointerCapture(e.pointerId);
  }
  if (current.kind === 'pan') {
    if (!current.moved) {
      state.selection.clear();
      state.selectedEdge = undefined;
      renderCanvas();
      renderInspector();
      persist();
    }
  } else if (current.kind === 'move') {
    if (current.moved) {
      commit(current.origins.size === 1 ? 'Move block' : 'Move blocks');
    }
  } else if (current.kind === 'connect') {
    const over = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('.node:not(.entry)');
    const target = over?.dataset.id;
    if (target && target !== current.from) {
      setOutputTarget(state.flow, current.from, current.key, target);
      commit('Connect');
    } else {
      renderCanvas();
    }
  } else if (current.kind === 'marquee') {
    marquee.hidden = true;
    state.selectedEdge = undefined;
    renderCanvas();
    renderInspector();
    persist();
  }
}

canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);

canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0025));
    } else {
      state.view.x -= e.shiftKey ? e.deltaY : e.deltaX;
      state.view.y -= e.shiftKey ? 0 : e.deltaY;
      applyView();
    }
  },
  { passive: false },
);

canvas.addEventListener('dblclick', (e) => {
  const nodeEl = (e.target as HTMLElement).closest<HTMLElement>('.node');
  if (nodeEl && nodeEl.dataset.id !== ENTRY_ID) {
    state.inspectorOpen = true;
    renderInspector();
    inspector.querySelector<HTMLTextAreaElement>('.json-input')?.focus();
  } else if (!nodeEl) {
    zoomAt(e.clientX, e.clientY, 1.4);
  }
});

canvas.addEventListener('dragover', (e) => {
  if (e.dataTransfer?.types.includes('application/x-flow-block')) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }
});

canvas.addEventListener('drop', (e) => {
  const type = e.dataTransfer?.getData('application/x-flow-block');
  if (!type) {
    return;
  }
  e.preventDefault();
  const p = toWorld(e.clientX, e.clientY);
  state.selection.clear();
  addBlock(type, { x: p.x - NODE_WIDTH / 2, y: p.y - NODE_HEADER_HEIGHT / 2 });
});

window.addEventListener('keydown', (e) => {
  const target = e.target as HTMLElement;
  if (target.closest?.('input, textarea, select')) {
    return;
  }
  const mod = e.ctrlKey || e.metaKey;
  if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    deleteSelection();
  } else if (mod && e.key.toLowerCase() === 'd') {
    e.preventDefault();
    duplicateSelection();
  } else if (mod && e.key.toLowerCase() === 'a') {
    e.preventDefault();
    state.selection = new Set(allNodeIds());
    render();
  } else if (mod && e.key.toLowerCase() === 'f') {
    e.preventDefault();
    toolbar.querySelector<HTMLInputElement>('.search')?.focus();
  } else if (!mod && e.key.toLowerCase() === 'f') {
    fitToScreen(state.selection.size > 0 ? [...state.selection] : undefined);
  } else if (e.key === 'Escape') {
    state.selection.clear();
    state.selectedEdge = undefined;
    state.showIssues = false;
    render();
  } else if (!mod && (e.key === '+' || e.key === '=')) {
    zoomCenter(1.2);
  } else if (!mod && e.key === '-') {
    zoomCenter(1 / 1.2);
  } else if (e.key.startsWith('Arrow') && state.flow && state.selection.size > 0) {
    e.preventDefault();
    const step = e.shiftKey ? 50 : 10;
    const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
    const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
    for (const id of state.selection) {
      const p = positionOf(id);
      setPosition(state.flow, id, { x: p.x + dx, y: p.y + dy });
    }
    commit('Move blocks');
  }
});

// The webview can load while hidden (zero size); fit once it first gets a real size.
let pendingFit = false;
function fitIfPending(): void {
  const rect = canvas.getBoundingClientRect();
  if (pendingFit && state.flow && rect.width > 0 && rect.height > 0) {
    pendingFit = false;
    fitToScreen();
  }
}
new ResizeObserver(() => {
  fitIfPending();
  applyView();
}).observe(canvas);

// ---------------------------------------------------------------------------
// Host messages

window.addEventListener('message', (event: MessageEvent<HostToWebview>) => {
  const message = event.data;
  switch (message.type) {
    case 'document': {
      state.fileName = message.fileName;
      if (message.fromWebview && state.flow) {
        return;
      }
      const result = parseFlow(message.text);
      if (result.flow) {
        const firstLoad = !state.flow;
        state.flow = result.flow;
        state.error = undefined;
        state.notAFlow = false;
        ensurePositions(state.flow);
        state.issues = validateFlow(state.flow);
        const ids = new Set(allNodeIds());
        state.selection = new Set([...state.selection].filter((id) => ids.has(id)));
        render();
        if (firstLoad && !state.hasView) {
          pendingFit = true;
          fitIfPending();
        }
        applyView();
      } else {
        state.error = result.error;
        state.notAFlow = !!result.notAFlow && !state.flow;
        render();
      }
      break;
    }
    case 'aws':
      state.awsConnected = message.connected;
      renderToolbar();
      renderInspector();
      break;
    case 'link':
      state.link = message.link;
      renderToolbar();
      renderInspector();
      break;
    case 'busy':
      state.busy = message.busy ? (message.message ?? 'Working…') : undefined;
      renderToolbar();
      break;
  }
});

render();
applyView();
post({ type: 'ready' });
