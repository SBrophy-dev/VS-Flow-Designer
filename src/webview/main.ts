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
  edgeKey,
  ensurePositions,
  findAction,
  findLoopEdges,
  getOutputs,
  getPosition,
  linkedFlowRef,
  nodeHeight,
  parseFlow,
  reachableFrom,
  reachingTo,
  removeBranch,
  setOutputTarget,
  setPosition,
  summarizeAction,
  validateFlow,
  type ContactFlow,
  type FlowAction,
  type FlowIssue,
  type OutputKind,
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
  showErrorLines?: boolean;
  leftTab?: 'outline' | 'blocks';
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
  /** Draw error branches as lines; otherwise they show as "→ Block" labels. */
  showErrorLines: saved?.showErrorLines ?? false,
  leftTab: saved?.leftTab ?? ('outline' as 'outline' | 'blocks'),
  /** Highlights every path into ("to") or out of ("from") a block. */
  trace: undefined as { id: string; mode: 'to' | 'from' } | undefined,
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
    showErrorLines: state.showErrorLines,
    leftTab: state.leftTab,
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
const hoverCard = h('div', { class: 'hover-card', hidden: true });
const edgeTip = h('div', { class: 'edge-tip', hidden: true });
const traceBar = h('div', { class: 'trace-bar', hidden: true });
const legend = h('div', { class: 'legend' });

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
canvas.append(world, marquee, hint, legend, traceBar, hoverCard, edgeTip, overlay);
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

interface Box {
  top: number;
  bottom: number;
}

interface Rect extends Box {
  left: number;
  right: number;
}

/** Horizontal run out of an output dot before a connection may turn. */
const EDGE_STUB = 16;
/** Gap left of a block where every connection into it shares one vertical trunk. */
const EDGE_TRUNK_GAP = 28;
const EDGE_RADIUS = 8;

function boxOf(id: string): Box {
  const p = positionOf(id);
  return { top: p.y, bottom: p.y + sizeOf(id).height };
}

/**
 * Routes a connection as right-angled segments. Forward connections run level out of the
 * dot and turn once, on the target's trunk, so several connections into one block merge
 * into a single line. Connections that go backwards or need room to turn detour through
 * the gap between the blocks, or under both when they overlap vertically, dropping
 * below any other block in the way.
 */
function edgeRoute(a: Position, b: Position, lane: number, src?: Box, dst?: Box, obstacles: Rect[] = []): Position[] {
  const room = b.x - a.x;
  if (room >= 6) {
    // Blocks placed close together still turn between them rather than looping around.
    const x = b.x - Math.min(EDGE_TRUNK_GAP, room / 2);
    return Math.abs(a.y - b.y) < 1 ? [a, b] : [a, { x, y: a.y }, { x, y: b.y }, b];
  }
  const trunkX = b.x - EDGE_TRUNK_GAP;
  const exitX = a.x + EDGE_STUB + lane * 6;
  let laneY: number;
  if (!src || !dst) {
    laneY = (a.y + b.y) / 2;
  } else if (dst.top - src.bottom > 24) {
    laneY = (src.bottom + dst.top) / 2;
  } else if (src.top - dst.bottom > 24) {
    laneY = (dst.bottom + src.top) / 2;
  } else {
    laneY = Math.max(src.bottom, dst.bottom) + 20;
    const left = Math.min(trunkX, exitX);
    const right = Math.max(trunkX, exitX);
    for (let moved = true; moved; ) {
      moved = false;
      for (const r of obstacles) {
        if (r.left < right && r.right > left && r.top < laneY + 4 && r.bottom + 20 > laneY) {
          laneY = r.bottom + 20;
          moved = true;
        }
      }
    }
  }
  return [a, { x: exitX, y: a.y }, { x: exitX, y: laneY }, { x: trunkX, y: laneY }, { x: trunkX, y: b.y }, b];
}

/** SVG path through the points with rounded corners. */
function roundedPath(points: Position[]): string {
  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const [p, c, n] = [points[i - 1], points[i], points[i + 1]];
    const inLen = Math.hypot(c.x - p.x, c.y - p.y);
    const outLen = Math.hypot(n.x - c.x, n.y - c.y);
    const r = Math.min(EDGE_RADIUS, inLen / 2, outLen / 2);
    if (r < 0.5) {
      d += ` L ${c.x} ${c.y}`;
      continue;
    }
    const start = { x: c.x - ((c.x - p.x) / inLen) * r, y: c.y - ((c.y - p.y) / inLen) * r };
    const end = { x: c.x + ((n.x - c.x) / outLen) * r, y: c.y + ((n.y - c.y) / outLen) * r };
    d += ` L ${start.x} ${start.y} Q ${c.x} ${c.y} ${end.x} ${end.y}`;
  }
  const last = points[points.length - 1];
  return `${d} L ${last.x} ${last.y}`;
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
      button('☰', 'Toggle the left panel (outline and blocks)', () => {
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
      button(
        'Error lines',
        state.showErrorLines
          ? 'Error branches are drawn as lines. Click to show them as labels instead.'
          : 'Error branches show as "→ Block" labels. Click to draw them as lines.',
        () => {
          state.showErrorLines = !state.showErrorLines;
          persist();
          renderToolbar();
          renderCanvas();
        },
        { class: `btn${state.showErrorLines ? ' active' : ''}`, disabled: !flow },
      ),
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
  const tab = (id: 'outline' | 'blocks', label: string, title: string) =>
    h(
      'button',
      {
        class: `palette-tab${state.leftTab === id ? ' active' : ''}`,
        title,
        onClick: () => {
          state.leftTab = id;
          persist();
          renderPalette();
        },
      },
      label,
    );
  const tabs = h(
    'div',
    { class: 'palette-tabs' },
    tab('outline', 'Outline', 'The flow as a list, in the order a contact moves through it'),
    tab('blocks', 'Blocks', 'Blocks you can add to the flow'),
  );
  palette.classList.toggle('outline-mode', state.leftTab === 'outline');
  if (state.leftTab === 'outline') {
    refreshDerived();
    const scroll = palette.querySelector('.outline')?.scrollTop ?? 0;
    const outline = state.flow ? renderOutline(state.flow) : h('div', { class: 'outline' });
    palette.replaceChildren(tabs, outline);
    outline.scrollTop = scroll;
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
  palette.replaceChildren(tabs, input, h('div', { class: 'palette-list' }, ...groups));
}

interface OutputGroup {
  target: string | undefined;
  kind: OutputKind;
  labels: string[];
  keys: string[];
}

/** A block's outputs, with outputs that go to the same block merged into one entry. */
function groupOutputs(action: FlowAction): OutputGroup[] {
  const groups: OutputGroup[] = [];
  for (const o of getOutputs(action)) {
    const existing = groups.find((g) => g.target === o.target);
    if (existing) {
      existing.labels.push(o.label);
      existing.keys.push(o.key);
    } else {
      groups.push({ target: o.target, kind: o.kind, labels: [o.label], keys: [o.key] });
    }
  }
  return groups;
}

/**
 * The flow as an indented list. The main path (the first success or condition branch to
 * a block not listed yet) continues at the same level; other branches nest under their
 * block; blocks already listed appear as "↪" links.
 */
function renderOutline(flow: ContactFlow): HTMLElement {
  const byId = new Map(flow.Actions.map((a) => [a.Identifier, a]));
  const seen = new Set<string>();
  const selected = state.selection.size === 1 ? [...state.selection][0] : undefined;

  const blockRow = (id: string, ref = false, loop = false) => {
    const action = byId.get(id)!;
    const summary = summarizeAction(action, flow.Metadata?.ActionMetadata?.[id]);
    const traced = tracedNodes && !tracedNodes.has(id) ? ' dimmed' : '';
    return h(
      'div',
      {
        class: `ol-row${ref ? ' ref' : ''}${id === selected ? ' active' : ''}${traced}`,
        style: { '--cat': CATEGORY_COLORS[getBlockCategory(action.Type)] },
        title: ref ? 'Already listed above. Click to go to the block.' : 'Go to the block',
        onClick: () => goTo(id),
      },
      ref ? h('span', { class: 'ol-ref' }, loop ? '↻' : '↪') : h('span', { class: 'palette-dot' }),
      h('span', { class: 'ol-label' }, getBlockLabel(action.Type)),
      summary ? h('span', { class: 'ol-summary' }, truncate(summary, ref ? 32 : 60)) : null,
    );
  };
  const branchLabel = (g: OutputGroup) => h('span', { class: `ol-branch-label ${g.kind}` }, g.labels.join(' · '));

  const branchItem = (from: string, g: OutputGroup): HTMLElement => {
    let body: Node;
    if (!g.target) {
      body = h('span', { class: 'muted' }, 'not connected');
    } else if (!byId.has(g.target)) {
      body = h('span', { class: 'issue-icon' }, '⚠ missing block');
    } else if (seen.has(g.target)) {
      body = blockRow(g.target, true, g.keys.some((k) => loopEdges.has(edgeKey(from, k))));
    } else {
      body = h('ul', { class: 'ol-chain' }, ...chain(g.target));
    }
    return h('li', { class: 'ol-branch' }, branchLabel(g), body);
  };

  // Walks the main path first so it claims its blocks, then fills in side branches.
  const chain = (start: string): HTMLElement[] => {
    const steps: { id: string; li: HTMLElement; others: OutputGroup[] }[] = [];
    let id: string | undefined = start;
    let via: OutputGroup | undefined;
    while (id && !seen.has(id)) {
      seen.add(id);
      const groups = groupOutputs(byId.get(id)!);
      const main = groups.find((g) => g.target && g.kind !== 'error' && byId.has(g.target) && !seen.has(g.target));
      const li = h('li', { class: 'ol-step' }, via ? h('div', { class: 'ol-connector' }, '↓ ', branchLabel(via)) : null, blockRow(id));
      steps.push({ id, li, others: groups.filter((g) => g !== main) });
      via = main;
      id = main?.target;
    }
    for (const step of steps) {
      if (step.others.length) {
        step.li.append(h('ul', { class: 'ol-branches' }, ...step.others.map((g) => branchItem(step.id, g))));
      }
    }
    return steps.map((s) => s.li);
  };

  const items: HTMLElement[] = [
    h('li', { class: 'ol-step' }, h('div', { class: 'ol-row entry', onClick: () => goTo(ENTRY_ID) }, h('span', { class: 'ol-ref' }, '▶'), 'Entry')),
  ];
  if (flow.StartAction && byId.has(flow.StartAction)) {
    items.push(...chain(flow.StartAction));
  }
  const unreachable = flow.Actions.filter((a) => !seen.has(a.Identifier));
  const rest: HTMLElement[] = [];
  for (const action of unreachable) {
    if (!seen.has(action.Identifier)) {
      rest.push(...chain(action.Identifier));
    }
  }
  return h(
    'div',
    { class: 'outline' },
    h('ul', { class: 'ol-chain root' }, ...items),
    rest.length ? h('div', { class: 'palette-heading muted' }, 'Not reachable from the start') : null,
    rest.length ? h('ul', { class: 'ol-chain root' }, ...rest) : null,
  );
}

/** Selects a block and scrolls the canvas to it. */
function goTo(id: string): void {
  state.selection = new Set([id]);
  state.selectedEdge = undefined;
  state.showIssues = false;
  hideHoverCard();
  centerOn(id);
  render();
  persist();
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

function present(...nodes: (Node | null | undefined)[]): Node[] {
  return nodes.filter((n): n is Node => !!n);
}

/** Loop transitions (edgeKey strings) and the blocks they return to. */
let loopEdges = new Set<string>();
let loopTargets = new Set<string>();
/** Blocks on the traced paths, when tracing. */
let tracedNodes: Set<string> | undefined;

function refreshDerived(): void {
  const flow = state.flow;
  loopEdges = flow ? findLoopEdges(flow) : new Set();
  loopTargets = new Set();
  for (const action of flow?.Actions ?? []) {
    for (const o of getOutputs(action)) {
      if (o.target && loopEdges.has(edgeKey(action.Identifier, o.key))) {
        loopTargets.add(o.target);
      }
    }
  }
  if (flow && state.trace && !findAction(flow, state.trace.id)) {
    state.trace = undefined;
  }
  tracedNodes = undefined;
  if (flow && state.trace) {
    tracedNodes = state.trace.mode === 'from' ? reachableFrom(flow, state.trace.id) : reachingTo(flow, state.trace.id);
    if (state.trace.mode === 'to' && flow.StartAction && tracedNodes.has(flow.StartAction)) {
      tracedNodes.add(ENTRY_ID);
    }
  }
}

function isTraced(from: string, target: string): boolean | undefined {
  return tracedNodes ? tracedNodes.has(from) && tracedNodes.has(target) : undefined;
}

/** Error branches show as labels unless lines are on or the branch is in focus. */
function errorAsLabel(from: string, target: string): boolean {
  return !state.showErrorLines && !state.selection.has(from) && !state.selection.has(target) && !isTraced(from, target);
}

/**
 * Short block name for labels: "Disconnect / hang up" becomes "Disconnect". When the flow
 * has several blocks of that type, the start of the summary tells them apart.
 */
function shortLabel(id: string): string {
  const flow = state.flow;
  const action = flow && findAction(flow, id);
  if (!action) {
    return id.slice(0, 8);
  }
  const name = getBlockLabel(action.Type).split(' / ')[0];
  const summary = summarizeAction(action, flow.Metadata?.ActionMetadata?.[id]);
  const shared = flow.Actions.some((a) => a.Type === action.Type && a.Identifier !== id);
  return shared && summary ? `${truncate(name, 14)}: ${summary}` : truncate(name, 20);
}

function startTrace(id: string, mode: 'to' | 'from'): void {
  state.trace = { id, mode };
  renderCanvas();
  renderPalette();
  renderInspector();
}

function clearTrace(): void {
  if (state.trace) {
    state.trace = undefined;
    renderCanvas();
    renderPalette();
    renderInspector();
  }
}

function renderTraceBar(): void {
  const flow = state.flow;
  const action = flow && state.trace && findAction(flow, state.trace.id);
  traceBar.hidden = !action;
  if (!action || !state.trace || !tracedNodes) {
    return;
  }
  const { id, mode } = state.trace;
  const count = [...tracedNodes].filter((n) => n !== ENTRY_ID && n !== id).length;
  traceBar.replaceChildren(
    h('span', {}, mode === 'to' ? 'Paths to ' : 'Paths from ', h('strong', {}, getBlockLabel(action.Type)), h('span', { class: 'muted' }, ` · ${count} other block${count === 1 ? '' : 's'}`)),
    button(mode === 'to' ? 'Show paths from here' : 'Show paths to here', 'Switch direction (Shift+T / T)', () => startTrace(id, mode === 'to' ? 'from' : 'to'), { class: 'btn small' }),
    button('Clear', 'Stop tracing (Esc)', clearTrace, { class: 'btn small' }),
  );
}

function renderLegend(): void {
  const line = (kind: string, label: string) => h('span', { class: 'legend-item' }, h('span', { class: `legend-line ${kind}` }), label);
  legend.replaceChildren(
    ...present(
      line('next', 'Success'),
      line('condition', 'Condition'),
      line('error', 'Error'),
      h('span', { class: 'legend-item' }, h('span', { class: 'legend-loop' }, '↻'), 'Loop'),
      state.showErrorLines ? null : h('span', { class: 'legend-item' }, h('span', { class: 'stub legend-stub' }, '→ Block'), 'Error label (click to jump)'),
    ),
  );
}

function renderCanvas(): void {
  const flow = state.flow;
  refreshDerived();
  renderTraceBar();
  renderLegend();
  legend.hidden = !flow;
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
        class: `node entry${state.selection.has(ENTRY_ID) ? ' selected' : ''}${tracedNodes && !tracedNodes.has(ENTRY_ID) ? ' dimmed' : ''}`,
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
    const meta = flow.Metadata?.ActionMetadata?.[id];
    const summary = summarizeAction(action, meta);
    const link = linkedFlowRef(action, meta);
    const classes = ['node'];
    if (state.selection.has(id)) {
      classes.push('selected');
    }
    if (searching) {
      classes.push(matchesSearch(action) ? 'match' : 'dimmed');
    } else if (tracedNodes) {
      classes.push(tracedNodes.has(id) ? (state.trace?.id === id ? 'match' : '') : 'dimmed');
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
        },
        h('span', { class: 'port in', title: 'Drop a connection here' }),
        h(
          'div',
          { class: 'node-header' },
          h('span', { class: 'node-title' }, getBlockLabel(action.Type)),
          loopTargets.has(id) ? h('span', { class: 'node-loop', title: 'A loop comes back to this block' }, '↻') : null,
          link
            ? h('button', { class: 'node-link', title: `Open the linked ${link.kind}: ${link.name}`, dataset: { ref: link.reference, name: link.name } }, '↗')
            : null,
          worst ? h('span', { class: `node-badge ${worst}` }, worst === 'error' ? '!' : '⚠') : null,
        ),
        h('div', { class: 'node-summary' }, summary ? truncate(summary, 140) : h('span', { class: 'muted' }, action.Type)),
        h(
          'div',
          { class: 'node-outputs' },
          ...getOutputs(action).map((o) =>
            h(
              'div',
              { class: `node-output ${o.kind}` },
              h('span', { class: 'output-label' }, truncate(o.label, 28)),
              h('span', { class: `port out ${o.kind}${o.target ? ' connected' : ''}`, dataset: { key: o.key }, title: `Drag to connect "${o.label}". Alt+click to disconnect.` }),
              o.kind === 'error' && o.target && findAction(flow, o.target) && errorAsLabel(id, o.target)
                ? h('span', { class: 'stub', dataset: { target: o.target }, title: `${o.label} → ${describeAction(findAction(flow, o.target)!)}\nClick to go there.` }, `→ ${shortLabel(o.target)}`)
                : null,
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
  const layers: Record<string, SVGElement[]> = { error: [], condition: [], next: [], front: [] };
  const flow = state.flow;
  if (flow) {
    const ids = new Set(flow.Actions.map((a) => a.Identifier));
    const obstacles: Rect[] = flow.Actions.map((a) => {
      const p = positionOf(a.Identifier);
      return { left: p.x, right: p.x + NODE_WIDTH, top: p.y, bottom: p.y + nodeHeight(a) };
    });
    const draw = (from: string, key: string, kind: string, index: number, target: string | undefined) => {
      if (!target || !ids.has(target)) {
        return;
      }
      if (kind === 'error' && errorAsLabel(from, target)) {
        return;
      }
      const selected = state.selectedEdge?.from === from && state.selectedEdge.key === key;
      const points = edgeRoute(outputPoint(from, index), inputPoint(target), index, boxOf(from), boxOf(target), obstacles);
      const d = roundedPath(points);
      const related = state.selection.has(from) || state.selection.has(target);
      const loop = loopEdges.has(edgeKey(from, key));
      const traced = isTraced(from, target);
      const classes = ['edge', kind];
      if (selected) {
        classes.push('selected');
      }
      if (related) {
        classes.push('related');
      }
      if (loop) {
        classes.push('loop');
      }
      if (traced !== undefined) {
        classes.push(traced ? 'traced' : 'untraced');
      }
      // Error paths sit underneath, and selected, related or traced ones on top, so the main path reads first.
      (selected || related || traced ? layers.front : (layers[kind] ?? layers.next)).push(
        s(
          'g',
          { class: 'edge-group', dataset: { from, to: target } },
          s('path', { d, class: 'edge-hit', dataset: { from, key } }),
          s('path', { d, class: classes.join(' '), 'marker-end': `url(#arrow-${selected ? 'selected' : kind})` }),
          loop ? loopBadge(points, kind) : null,
        ),
      );
    };
    draw(ENTRY_ID, 'next', 'next', 0, flow.StartAction);
    for (const action of flow.Actions) {
      getOutputs(action).forEach((o, i) => draw(action.Identifier, o.key, o.kind, i, o.target));
    }
  }
  if (pending) {
    layers.front.push(s('path', { d: roundedPath(edgeRoute(pending.from, pending.to, 0)), class: 'edge pending', 'marker-end': 'url(#arrow-pending)' }));
  }
  edgesSvg.replaceChildren(defs, ...layers.error, ...layers.condition, ...layers.next, ...layers.front);
  highlightEdges(hoveredNode);
}

/** A ↻ marker in the middle of the longest straight run of a loop connection. */
function loopBadge(points: Position[], kind: string): SVGElement {
  let best = { x: points[0].x, y: points[0].y, length: -1 };
  for (let i = 1; i < points.length; i++) {
    const [a, b] = [points[i - 1], points[i]];
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length > best.length) {
      best = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, length };
    }
  }
  return s(
    'g',
    { class: `loop-badge ${kind}`, transform: `translate(${best.x} ${best.y})` },
    s('title', {}, 'Loop: this connection goes back to an earlier block'),
    s('circle', { r: 8 }),
    s('text', { 'text-anchor': 'middle', dy: '0.35em' }, '↻'),
  );
}

let hoveredNode: string | undefined;

/** Emphasises the connections into and out of the hovered block and fades the rest. */
function highlightEdges(id: string | undefined): void {
  hoveredNode = id;
  edgesSvg.classList.toggle('focus', !!id);
  edgesSvg.querySelectorAll<SVGGElement>('.edge-group').forEach((g) => {
    g.classList.toggle('hover', !!id && (g.dataset.from === id || g.dataset.to === id));
  });
}

// ---------------------------------------------------------------------------
// Hover card and connection labels

let hoverTimer: ReturnType<typeof setTimeout> | undefined;

function hideHoverCard(): void {
  clearTimeout(hoverTimer);
  hoverCard.hidden = true;
}

function scheduleHoverCard(id: string | undefined): void {
  hideHoverCard();
  if (id && id !== ENTRY_ID && !drag) {
    hoverTimer = setTimeout(() => showHoverCard(id), 450);
  }
}

function formatValue(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return truncate(text ?? '', 160);
}

/** Everything a reader needs about a block without selecting it. */
function showHoverCard(id: string): void {
  const flow = state.flow;
  const action = flow && findAction(flow, id);
  if (!flow || !action || drag) {
    return;
  }
  const meta = flow.Metadata?.ActionMetadata?.[id];
  const summary = summarizeAction(action, meta);
  const link = linkedFlowRef(action, meta);
  const params = Object.entries(action.Parameters ?? {});
  const issues = issuesFor(id);
  const MAX_PARAMS = 8;
  hoverCard.replaceChildren(
    ...present(
      h(
        'div',
        { class: 'card-title', style: { '--cat': CATEGORY_COLORS[getBlockCategory(action.Type)] } },
        h('span', { class: 'palette-dot' }),
        h('strong', {}, getBlockLabel(action.Type)),
        h('span', { class: 'muted small' }, action.Type),
      ),
      summary ? h('p', { class: 'card-summary' }, summary) : null,
      link ? h('p', { class: 'card-link' }, `${link.kind === 'module' ? 'Module' : 'Flow'}: ${link.name}`, h('span', { class: 'muted' }, '  (↗ in the header opens it)')) : null,
      params.length
        ? h(
            'dl',
            { class: 'facts card-params' },
            ...params.slice(0, MAX_PARAMS).flatMap(([key, value]) => [h('dt', {}, key), h('dd', {}, formatValue(value))]),
            params.length > MAX_PARAMS ? h('dd', { class: 'muted' }, `+ ${params.length - MAX_PARAMS} more in the inspector`) : null,
          )
        : null,
      h(
        'ul',
        { class: 'card-branches' },
        ...getOutputs(action).map((o) => {
          const target = o.target ? findAction(flow, o.target) : undefined;
          return h(
            'li',
            { class: o.kind },
            h('span', { class: 'card-branch-label' }, o.label),
            ' → ',
            target ? describeAction(target) : h('span', { class: 'muted' }, o.target ? 'missing block' : 'not connected'),
            loopEdges.has(edgeKey(id, o.key)) ? h('span', { class: 'legend-loop' }, ' ↻') : null,
          );
        }),
      ),
      issues.length ? h('ul', { class: 'card-issues' }, ...issues.map((i) => h('li', { class: i.severity }, i.message))) : null,
      h('div', { class: 'muted small card-id' }, id),
    ),
  );
  hoverCard.hidden = false;
  const rect = canvas.getBoundingClientRect();
  const p = positionOf(id);
  const { zoom, x, y } = state.view;
  const right = (p.x + NODE_WIDTH) * zoom + x + 14;
  const left = p.x * zoom + x - hoverCard.offsetWidth - 14;
  const cardX = right + hoverCard.offsetWidth < rect.width - 8 || left < 8 ? right : left;
  const cardY = Math.min(Math.max(8, p.y * zoom + y), rect.height - hoverCard.offsetHeight - 8);
  hoverCard.style.left = `${Math.max(8, cardX)}px`;
  hoverCard.style.top = `${Math.max(8, cardY)}px`;
}

function describeEdge(from: string, key: string): string {
  const flow = state.flow!;
  if (from === ENTRY_ID) {
    const start = flow.StartAction ? findAction(flow, flow.StartAction) : undefined;
    return `Entry → ${start ? describeAction(start) : ''}`;
  }
  const action = findAction(flow, from);
  const output = action ? getOutputs(action).find((o) => o.key === key) : undefined;
  const target = output?.target ? findAction(flow, output.target) : undefined;
  if (!action || !output || !target) {
    return '';
  }
  const loop = loopEdges.has(edgeKey(from, key)) ? '  ↻ loop' : '';
  return `${getBlockLabel(action.Type)} · ${output.label} → ${describeAction(target)}${loop}`;
}

function placeEdgeTip(e: PointerEvent): void {
  const rect = canvas.getBoundingClientRect();
  const x = Math.min(e.clientX - rect.left + 14, rect.width - edgeTip.offsetWidth - 8);
  edgeTip.style.left = `${Math.max(8, x)}px`;
  edgeTip.style.top = `${e.clientY - rect.top + 16}px`;
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
        h('li', {}, 'Select a block and press T to trace every path to it, Shift+T for paths from it.'),
        h('li', {}, 'Hover a block or a line for details. Click a "→ Block" label to jump there.'),
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
  const link = linkedFlowRef(action, flow.Metadata?.ActionMetadata?.[id]);

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
    h(
      'div',
      { class: 'row' },
      button('Trace paths to here', 'Highlight every path that leads to this block (T)', () => startTrace(id, 'to'), {
        class: `btn small${state.trace?.id === id && state.trace.mode === 'to' ? ' active' : ''}`,
      }),
      button('Trace from here', 'Highlight everything that can happen after this block (Shift+T)', () => startTrace(id, 'from'), {
        class: `btn small${state.trace?.id === id && state.trace.mode === 'from' ? ' active' : ''}`,
      }),
    ),
    link
      ? section(
          link.kind === 'module' ? 'Linked module' : 'Linked flow',
          h('div', {}, link.name),
          link.name !== link.reference ? h('code', { class: 'muted small ref-code' }, link.reference) : null,
          h(
            'div',
            { class: 'row' },
            button('Open', 'Open the linked file if it is in this workspace', () => post({ type: 'openFlow', reference: link.reference, name: link.name }), {
              class: 'btn small',
            }),
          ),
        )
      : null,
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
  hideHoverCard();
  edgeTip.hidden = true;

  const stub = target.closest<HTMLElement>('.stub');
  if (stub?.dataset.target) {
    e.preventDefault();
    goTo(stub.dataset.target);
    return;
  }
  const linkButton = target.closest<HTMLElement>('.node-link');
  if (linkButton) {
    e.preventDefault();
    post({ type: 'openFlow', reference: linkButton.dataset.ref!, name: linkButton.dataset.name });
    return;
  }

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

canvas.addEventListener('pointerover', (e) => {
  const target = e.target as Element;
  const id = drag ? undefined : target.closest<HTMLElement>('.node')?.dataset.id;
  if (id !== hoveredNode) {
    highlightEdges(id);
    scheduleHoverCard(id);
  }
  const hit = drag ? null : target.closest<SVGPathElement>('.edge-hit');
  const text = hit ? describeEdge(hit.dataset.from!, hit.dataset.key!) : '';
  edgeTip.hidden = !text;
  if (text) {
    edgeTip.textContent = text;
    placeEdgeTip(e);
  }
});
canvas.addEventListener('pointermove', (e) => {
  if (!edgeTip.hidden) {
    placeEdgeTip(e);
  }
});
canvas.addEventListener('pointerleave', () => {
  highlightEdges(undefined);
  hideHoverCard();
  edgeTip.hidden = true;
});

canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);

canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    hideHoverCard();
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
  } else if (e.key === 'Escape' && state.trace) {
    clearTrace();
  } else if (!mod && e.key.toLowerCase() === 't' && state.selection.size === 1) {
    const id = [...state.selection][0];
    if (id !== ENTRY_ID) {
      startTrace(id, e.shiftKey ? 'from' : 'to');
    }
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
