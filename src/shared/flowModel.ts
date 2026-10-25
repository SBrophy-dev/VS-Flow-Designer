// Pure data model for Amazon Connect flows (the "Flow language" JSON). Shared by the
// extension host and the webview, so it must not import vscode or DOM APIs.
import { getBlockDefinition } from './blockCatalog';

export interface Position {
  x: number;
  y: number;
}

export interface FlowCondition {
  NextAction?: string;
  Condition: { Operator: string; Operands: string[] };
}

export interface FlowError {
  NextAction?: string;
  ErrorType: string;
}

export interface FlowTransitions {
  NextAction?: string;
  Errors?: FlowError[];
  Conditions?: FlowCondition[];
  [key: string]: unknown;
}

export interface FlowAction {
  Identifier: string;
  Type: string;
  Parameters?: Record<string, unknown>;
  Transitions?: FlowTransitions;
  [key: string]: unknown;
}

export interface ActionMetadata {
  position?: Position;
  [key: string]: unknown;
}

export interface FlowAnnotation {
  id?: string;
  content?: string;
  position?: Position;
  size?: { width?: number; height?: number };
  [key: string]: unknown;
}

export interface FlowMetadata {
  entryPointPosition?: Position;
  ActionMetadata?: Record<string, ActionMetadata>;
  Annotations?: FlowAnnotation[];
  name?: string;
  description?: string;
  type?: string;
  status?: string;
  [key: string]: unknown;
}

export interface ContactFlow {
  Version: string;
  StartAction?: string;
  Metadata?: FlowMetadata;
  Actions: FlowAction[];
  [key: string]: unknown;
}

export type OutputKind = 'next' | 'condition' | 'error';

export interface FlowOutput {
  /** Stable key within an action: "next", "condition:<index>" or "error:<index>". */
  key: string;
  kind: OutputKind;
  label: string;
  target?: string;
}

export type IssueSeverity = 'error' | 'warning' | 'info';

export interface FlowIssue {
  severity: IssueSeverity;
  message: string;
  actionId?: string;
  outputKey?: string;
}

export const FLOW_VERSION = '2019-10-30';
export const ENTRY_ID = '__entry__';

export const NODE_WIDTH = 220;
export const NODE_HEADER_HEIGHT = 30;
export const NODE_SUMMARY_HEIGHT = 34;
export const NODE_OUTPUT_HEIGHT = 22;
export const NODE_PADDING_BOTTOM = 8;

// ---------------------------------------------------------------------------
// Parsing

export function looksLikeFlow(value: unknown): value is ContactFlow {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return Array.isArray(v.Actions) && (typeof v.Version === 'string' || typeof v.StartAction === 'string');
}

export interface ParseResult {
  flow?: ContactFlow;
  error?: string;
  /** True when the text is valid JSON but not a contact flow. */
  notAFlow?: boolean;
}

export function parseFlow(text: string): ParseResult {
  if (text.trim() === '') {
    return { error: 'The file is empty.', notAFlow: true };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    return { error: `The file is not valid JSON: ${(e as Error).message}` };
  }
  if (!looksLikeFlow(value)) {
    return {
      error: 'This JSON file does not look like an Amazon Connect flow. A flow needs a "Version" and an "Actions" array.',
      notAFlow: true,
    };
  }
  for (const [i, action] of value.Actions.entries()) {
    if (!action || typeof action !== 'object' || typeof action.Identifier !== 'string' || typeof action.Type !== 'string') {
      return { error: `Action #${i + 1} needs a string "Identifier" and "Type".` };
    }
  }
  return { flow: value };
}

/** Detects the indentation used by a JSON document: a string, or undefined for single-line JSON. */
export function detectIndent(text: string): string | undefined {
  const match = /^[{[]\s*?\r?\n([ \t]+)\S/.exec(text);
  if (match) {
    return match[1];
  }
  return text.trim().includes('\n') ? '  ' : undefined;
}

export function serializeFlow(flow: ContactFlow, indent: string | undefined, eol = '\n'): string {
  const json = JSON.stringify(flow, null, indent);
  return indent === undefined ? json : json.replace(/\n/g, eol) + eol;
}

// ---------------------------------------------------------------------------
// Queries

export function findAction(flow: ContactFlow, id: string): FlowAction | undefined {
  return flow.Actions.find((a) => a.Identifier === id);
}

export function getPosition(flow: ContactFlow, id: string): Position | undefined {
  if (id === ENTRY_ID) {
    return flow.Metadata?.entryPointPosition;
  }
  return flow.Metadata?.ActionMetadata?.[id]?.position;
}

const OPERATOR_SYMBOLS: Record<string, string> = {
  Equals: '=',
  NumberLessThan: '<',
  NumberLessOrEqualTo: '≤',
  NumberGreaterThan: '>',
  NumberGreaterOrEqualTo: '≥',
  TextContains: 'contains',
  TextStartsWith: 'starts with',
  TextEndsWith: 'ends with',
};

const SPECIAL_CONDITION_LABELS: Record<string, Record<string, string>> = {
  CheckHoursOfOperation: { True: 'In hours', False: 'Out of hours' },
  Loop: { ContinueLooping: 'Looping', DoneLooping: 'Complete' },
};

export function conditionLabel(actionType: string, condition: FlowCondition['Condition'] | undefined): string {
  if (!condition) {
    return 'Condition';
  }
  const operands = (condition.Operands ?? []).join(', ');
  const special = SPECIAL_CONDITION_LABELS[actionType]?.[operands];
  if (special) {
    return special;
  }
  if (condition.Operator === 'Equals') {
    return actionType === 'Compare' || actionType === 'CheckMetricData' ? `= ${operands}` : operands || '(empty)';
  }
  const op = OPERATOR_SYMBOLS[condition.Operator] ?? condition.Operator;
  return `${op} ${operands}`.trim();
}

const ERROR_LABELS: Record<string, string> = {
  NoMatchingError: 'Error',
  NoMatchingCondition: 'No match',
  InputTimeLimitExceeded: 'Timeout',
  QueueAtCapacity: 'At capacity',
  TimeLimitExceeded: 'Timeout',
  ConnectionTimeLimitExceeded: 'Timeout',
  CallFailed: 'Call failed',
  InvalidPhoneNumber: 'Invalid number',
};

export function errorLabel(errorType: string): string {
  return ERROR_LABELS[errorType] ?? errorType;
}

export function getOutputs(action: FlowAction): FlowOutput[] {
  const outputs: FlowOutput[] = [];
  const t = action.Transitions ?? {};
  const def = getBlockDefinition(action.Type);
  if (t.NextAction !== undefined || def?.hasNext) {
    outputs.push({ key: 'next', kind: 'next', label: 'Success', target: t.NextAction || undefined });
  }
  (t.Conditions ?? []).forEach((c, i) => {
    outputs.push({
      key: `condition:${i}`,
      kind: 'condition',
      label: conditionLabel(action.Type, c.Condition),
      target: c.NextAction || undefined,
    });
  });
  (t.Errors ?? []).forEach((e, i) => {
    outputs.push({ key: `error:${i}`, kind: 'error', label: errorLabel(e.ErrorType), target: e.NextAction || undefined });
  });
  return outputs;
}

export function nodeHeight(action: FlowAction): number {
  return NODE_HEADER_HEIGHT + NODE_SUMMARY_HEIGHT + getOutputs(action).length * NODE_OUTPUT_HEIGHT + NODE_PADDING_BOTTOM;
}

function shortArn(value: string): string {
  if (!value.startsWith('arn:')) {
    return value;
  }
  const parts = value.split(/[:/]/);
  return parts[parts.length - 1] || value;
}

function asText(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return undefined;
}

/** A one-line human summary of a block's most important parameter. */
export function summarizeAction(action: FlowAction, meta?: ActionMetadata): string {
  const p = action.Parameters ?? {};
  const metaParams = (meta?.parameters ?? {}) as Record<string, unknown>;
  const friendly = (key: string): string | undefined => {
    const m = metaParams[key] as Record<string, unknown> | string | undefined;
    if (typeof m === 'string') {
      return m;
    }
    return asText(m?.displayName) ?? asText(m?.text);
  };
  const text = asText(p.Text) ?? asText(p.SSML) ?? asText(p.PromptId);
  if (text) {
    return text.replace(/<[^>]+>/g, '');
  }
  const keyed: [string, string][] = [
    ['QueueId', 'Queue'],
    ['ContactFlowId', 'Flow'],
    ['FlowModuleId', 'Module'],
    ['LambdaFunctionARN', 'Lambda'],
    ['ComparisonValue', 'Check'],
    ['TextToSpeechVoice', 'Voice'],
    ['ThirdPartyPhoneNumber', 'To'],
    ['FlowLoggingBehavior', 'Logging'],
    ['MetricType', 'Metric'],
    ['LoopCount', 'Loops'],
    ['TimeLimitSeconds', 'Seconds'],
    ['LanguageCode', 'Language'],
    ['CallbackNumber', 'Number'],
    ['Hours', 'Hours'],
  ];
  for (const [key, label] of keyed) {
    const value = asText(p[key]);
    if (value !== undefined) {
      return `${label}: ${friendly(key) ?? shortArn(value)}`;
    }
  }
  if (p.Attributes && typeof p.Attributes === 'object') {
    const entries = Object.entries(p.Attributes as Record<string, unknown>);
    return entries.length ? entries.map(([k, v]) => `${k} = ${asText(v) ?? '…'}`).join(', ') : 'No attributes';
  }
  if (p.EventHooks && typeof p.EventHooks === 'object') {
    return Object.keys(p.EventHooks as object).join(', ');
  }
  if (p.LexV2Bot || p.LexBot) {
    return 'Lex bot';
  }
  const firstKey = Object.keys(p)[0];
  if (firstKey) {
    const value = asText(p[firstKey]);
    return value !== undefined ? `${firstKey}: ${shortArn(value)}` : firstKey;
  }
  return '';
}

// ---------------------------------------------------------------------------
// Validation

const TERMINAL_TYPES = new Set(['DisconnectParticipant', 'EndFlowExecution', 'EndFlowModuleExecution']);

export function validateFlow(flow: ContactFlow): FlowIssue[] {
  const issues: FlowIssue[] = [];
  const ids = new Set<string>();
  for (const action of flow.Actions) {
    if (ids.has(action.Identifier)) {
      issues.push({ severity: 'error', actionId: action.Identifier, message: `Duplicate block identifier "${action.Identifier}".` });
    }
    ids.add(action.Identifier);
  }

  if (!flow.StartAction) {
    issues.push({ severity: 'error', message: 'The flow has no start block (StartAction is empty).' });
  } else if (!ids.has(flow.StartAction)) {
    issues.push({ severity: 'error', message: `StartAction points to a missing block "${flow.StartAction}".` });
  }

  for (const action of flow.Actions) {
    for (const output of getOutputs(action)) {
      if (!output.target) {
        if (output.kind !== 'next' || !TERMINAL_TYPES.has(action.Type)) {
          issues.push({
            severity: 'warning',
            actionId: action.Identifier,
            outputKey: output.key,
            message: `"${output.label}" branch is not connected.`,
          });
        }
      } else if (!ids.has(output.target)) {
        issues.push({
          severity: 'error',
          actionId: action.Identifier,
          outputKey: output.key,
          message: `"${output.label}" branch points to a missing block "${output.target}".`,
        });
      }
    }
  }

  const reachable = reachableFrom(flow, flow.StartAction);
  for (const action of flow.Actions) {
    if (!reachable.has(action.Identifier)) {
      issues.push({ severity: 'info', actionId: action.Identifier, message: 'Block is not reachable from the start of the flow.' });
    }
  }
  return issues;
}

export function reachableFrom(flow: ContactFlow, start: string | undefined): Set<string> {
  const seen = new Set<string>();
  const byId = new Map(flow.Actions.map((a) => [a.Identifier, a]));
  const stack = start ? [start] : [];
  while (stack.length) {
    const id = stack.pop()!;
    const action = byId.get(id);
    if (!action || seen.has(id)) {
      continue;
    }
    seen.add(id);
    for (const output of getOutputs(action)) {
      if (output.target) {
        stack.push(output.target);
      }
    }
  }
  return seen;
}

// ---------------------------------------------------------------------------
// Mutations (all mutate the flow in place)

function ensureMetadata(flow: ContactFlow): FlowMetadata & { ActionMetadata: Record<string, ActionMetadata> } {
  flow.Metadata ??= {};
  flow.Metadata.ActionMetadata ??= {};
  return flow.Metadata as FlowMetadata & { ActionMetadata: Record<string, ActionMetadata> };
}

export function setPosition(flow: ContactFlow, id: string, position: Position): void {
  const meta = ensureMetadata(flow);
  const rounded = { x: Math.round(position.x * 10) / 10, y: Math.round(position.y * 10) / 10 };
  if (id === ENTRY_ID) {
    meta.entryPointPosition = rounded;
    return;
  }
  meta.ActionMetadata[id] = { ...(meta.ActionMetadata[id] ?? {}), position: rounded };
}

export function setOutputTarget(flow: ContactFlow, actionId: string, outputKey: string, target: string | undefined): void {
  if (actionId === ENTRY_ID) {
    flow.StartAction = target ?? '';
    return;
  }
  const action = findAction(flow, actionId);
  if (!action) {
    return;
  }
  action.Transitions ??= {};
  const t = action.Transitions;
  const [kind, indexText] = outputKey.split(':');
  const index = Number(indexText);
  if (kind === 'next') {
    if (target) {
      t.NextAction = target;
    } else {
      t.NextAction = '';
    }
  } else if (kind === 'condition' && t.Conditions?.[index]) {
    t.Conditions[index].NextAction = target ?? '';
  } else if (kind === 'error' && t.Errors?.[index]) {
    t.Errors[index].NextAction = target ?? '';
  }
}

export function createId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c?.randomUUID) {
    return c.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    return (ch === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export function createAction(type: string, id = createId()): FlowAction {
  const def = getBlockDefinition(type);
  const transitions: FlowTransitions = {};
  if (def?.hasNext ?? true) {
    transitions.NextAction = '';
  }
  if (def?.defaultErrors.length) {
    transitions.Errors = def.defaultErrors.map((ErrorType) => ({ NextAction: '', ErrorType }));
  }
  if (def?.defaultConditions.length) {
    transitions.Conditions = def.defaultConditions.map((c) => ({
      NextAction: '',
      Condition: { Operator: c.Operator, Operands: [...c.Operands] },
    }));
  }
  return {
    Parameters: structuredClone(def?.defaultParameters ?? {}),
    Identifier: id,
    Type: type,
    Transitions: transitions,
  };
}

export function addAction(flow: ContactFlow, action: FlowAction, position: Position): void {
  flow.Actions.push(action);
  setPosition(flow, action.Identifier, position);
  if (!flow.StartAction) {
    flow.StartAction = action.Identifier;
  }
}

/** Removes blocks and clears every transition that pointed at them. */
export function deleteActions(flow: ContactFlow, ids: Iterable<string>): void {
  const remove = new Set(ids);
  remove.delete(ENTRY_ID);
  flow.Actions = flow.Actions.filter((a) => !remove.has(a.Identifier));
  if (flow.Metadata?.ActionMetadata) {
    for (const id of remove) {
      delete flow.Metadata.ActionMetadata[id];
    }
  }
  if (flow.StartAction && remove.has(flow.StartAction)) {
    flow.StartAction = '';
  }
  for (const action of flow.Actions) {
    const t = action.Transitions;
    if (!t) {
      continue;
    }
    if (t.NextAction && remove.has(t.NextAction)) {
      t.NextAction = '';
    }
    for (const branch of [...(t.Conditions ?? []), ...(t.Errors ?? [])]) {
      if (branch.NextAction && remove.has(branch.NextAction)) {
        branch.NextAction = '';
      }
    }
  }
}

/**
 * Copies blocks with new identifiers. Transitions between copied blocks are remapped to
 * the copies; transitions to blocks outside the set are kept as they are.
 */
export function duplicateActions(flow: ContactFlow, ids: string[], offset: Position = { x: 40, y: 40 }): string[] {
  const idMap = new Map<string, string>();
  for (const id of ids) {
    if (findAction(flow, id)) {
      idMap.set(id, createId());
    }
  }
  const copies: string[] = [];
  for (const [oldId, newId] of idMap) {
    const original = findAction(flow, oldId)!;
    const copy = structuredClone(original);
    copy.Identifier = newId;
    const t = copy.Transitions;
    if (t) {
      const remap = (target: string | undefined) => (target && idMap.has(target) ? idMap.get(target)! : target);
      if (t.NextAction !== undefined) {
        t.NextAction = remap(t.NextAction);
      }
      for (const branch of [...(t.Conditions ?? []), ...(t.Errors ?? [])]) {
        branch.NextAction = remap(branch.NextAction);
      }
    }
    flow.Actions.push(copy);
    const meta = ensureMetadata(flow);
    const originalMeta = structuredClone(meta.ActionMetadata[oldId] ?? {});
    const pos = originalMeta.position ?? { x: 0, y: 0 };
    meta.ActionMetadata[newId] = { ...originalMeta, position: { x: pos.x + offset.x, y: pos.y + offset.y } };
    copies.push(newId);
  }
  return copies;
}

export function addBranch(flow: ContactFlow, actionId: string, kind: 'condition' | 'error', value: string): void {
  const action = findAction(flow, actionId);
  if (!action) {
    return;
  }
  action.Transitions ??= {};
  if (kind === 'condition') {
    (action.Transitions.Conditions ??= []).push({ NextAction: '', Condition: { Operator: 'Equals', Operands: [value] } });
  } else {
    (action.Transitions.Errors ??= []).push({ NextAction: '', ErrorType: value });
  }
}

export function removeBranch(flow: ContactFlow, actionId: string, outputKey: string): void {
  const action = findAction(flow, actionId);
  const t = action?.Transitions;
  if (!t) {
    return;
  }
  const [kind, indexText] = outputKey.split(':');
  const index = Number(indexText);
  if (kind === 'condition') {
    t.Conditions?.splice(index, 1);
  } else if (kind === 'error') {
    t.Errors?.splice(index, 1);
  } else if (kind === 'next') {
    delete t.NextAction;
  }
}

export function newFlow(name: string, type = 'contactFlow'): ContactFlow {
  const flow: ContactFlow = {
    Version: FLOW_VERSION,
    StartAction: '',
    Metadata: {
      entryPointPosition: { x: 40, y: 40 },
      ActionMetadata: {},
      Annotations: [],
      name,
      description: '',
      type,
      status: 'saved',
      hash: {},
    },
    Actions: [],
  };
  const greet = createAction('MessageParticipant');
  greet.Parameters = { Text: 'Thank you for calling. Goodbye.' };
  const disconnect = createAction('DisconnectParticipant');
  greet.Transitions = { NextAction: disconnect.Identifier, Errors: [{ NextAction: disconnect.Identifier, ErrorType: 'NoMatchingError' }] };
  addAction(flow, greet, { x: 200, y: 40 });
  addAction(flow, disconnect, { x: 520, y: 40 });
  flow.StartAction = greet.Identifier;
  return flow;
}

// ---------------------------------------------------------------------------
// Layout

export interface LayoutOptions {
  columnGap?: number;
  rowGap?: number;
  origin?: Position;
}

/**
 * Left-to-right layered layout. Each block goes in the column of its shortest distance
 * from the start; unreachable blocks go in columns after the reachable ones.
 */
export function autoLayout(flow: ContactFlow, options: LayoutOptions = {}): Map<string, Position> {
  const columnGap = options.columnGap ?? 90;
  const rowGap = options.rowGap ?? 40;
  const origin = options.origin ?? { x: 40, y: 40 };
  const byId = new Map(flow.Actions.map((a) => [a.Identifier, a]));
  const depth = new Map<string, number>();

  const bfs = (start: string, startDepth: number) => {
    const queue: string[] = [start];
    depth.set(start, startDepth);
    while (queue.length) {
      const id = queue.shift()!;
      const d = depth.get(id)!;
      for (const output of getOutputs(byId.get(id)!)) {
        if (output.target && byId.has(output.target) && !depth.has(output.target)) {
          depth.set(output.target, d + 1);
          queue.push(output.target);
        }
      }
    }
  };

  if (flow.StartAction && byId.has(flow.StartAction)) {
    bfs(flow.StartAction, 1);
  }
  let maxDepth = Math.max(0, ...depth.values());
  for (const action of flow.Actions) {
    if (!depth.has(action.Identifier)) {
      bfs(action.Identifier, maxDepth + 1);
      maxDepth = Math.max(maxDepth, ...depth.values());
    }
  }

  const columns = new Map<number, string[]>();
  // Order blocks in a column by the order their parents' outputs reference them.
  const order = new Map<string, number>();
  let counter = 0;
  const visit = (id: string) => {
    if (order.has(id)) {
      return;
    }
    order.set(id, counter++);
  };
  if (flow.StartAction) {
    visit(flow.StartAction);
  }
  const sortedByDepth = [...depth.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id);
  for (const id of sortedByDepth) {
    visit(id);
    for (const output of getOutputs(byId.get(id)!)) {
      if (output.target && byId.has(output.target)) {
        visit(output.target);
      }
    }
  }
  for (const id of sortedByDepth) {
    const d = depth.get(id)!;
    if (!columns.has(d)) {
      columns.set(d, []);
    }
    columns.get(d)!.push(id);
  }

  const positions = new Map<string, Position>();
  positions.set(ENTRY_ID, { x: origin.x, y: origin.y });
  for (const [d, ids] of columns) {
    ids.sort((a, b) => order.get(a)! - order.get(b)!);
    let y = origin.y;
    const x = origin.x + 140 + (d - 1) * (NODE_WIDTH + columnGap);
    for (const id of ids) {
      positions.set(id, { x, y });
      y += nodeHeight(byId.get(id)!) + rowGap;
    }
  }
  return positions;
}

export function applyLayout(flow: ContactFlow, positions: Map<string, Position>): void {
  for (const [id, pos] of positions) {
    setPosition(flow, id, pos);
  }
}

/** Places blocks that have no stored position (for example hand-written flows). */
export function ensurePositions(flow: ContactFlow): boolean {
  const missing = flow.Actions.filter((a) => !getPosition(flow, a.Identifier));
  if (missing.length === 0 && flow.Metadata?.entryPointPosition) {
    return false;
  }
  const layout = autoLayout(flow);
  if (!flow.Metadata?.entryPointPosition) {
    setPosition(flow, ENTRY_ID, layout.get(ENTRY_ID)!);
  }
  for (const action of missing) {
    setPosition(flow, action.Identifier, layout.get(action.Identifier)!);
  }
  return true;
}
