import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ENTRY_ID,
  addAction,
  addBranch,
  autoLayout,
  conditionLabel,
  createAction,
  deleteActions,
  detectIndent,
  duplicateActions,
  edgeKey,
  ensurePositions,
  findAction,
  findLoopEdges,
  getOutputs,
  linkedFlowRef,
  newFlow,
  parseFlow,
  reachableFrom,
  reachingTo,
  removeBranch,
  serializeFlow,
  setOutputTarget,
  summarizeAction,
  validateFlow,
  type ContactFlow,
} from '../src/shared/flowModel';
import { BLOCKS, getBlockLabel } from '../src/shared/blockCatalog';

const sampleText = readFileSync(join(__dirname, '..', '..', 'samples', 'Sample inbound flow.json'), 'utf8');
const sample = (): ContactFlow => parseFlow(sampleText).flow!;
const id = (n: number) => `7a1c0e5e-4f1b-4c1e-9a7d-0b8f2d3c4e${String(n).padStart(2, '0')}`;

test('parses the sample flow', () => {
  const flow = sample();
  assert.equal(flow.Actions.length, 11);
  assert.equal(flow.StartAction, id(1));
});

test('reports invalid JSON and non-flow JSON differently', () => {
  assert.match(parseFlow('{ nope').error!, /not valid JSON/);
  const notFlow = parseFlow('{"name": "package"}');
  assert.equal(notFlow.notAFlow, true);
  assert.match(parseFlow('{"Version":"2019-10-30","Actions":[{"Type":"X"}]}').error!, /Identifier/);
});

test('sample flow validates without errors or warnings', () => {
  const issues = validateFlow(sample()).filter((i) => i.severity !== 'info');
  assert.deepEqual(issues, []);
});

test('outputs list next, conditions and errors in order', () => {
  const input = findAction(sample(), id(4))!;
  const outputs = getOutputs(input);
  assert.deepEqual(
    outputs.map((o) => [o.key, o.label]),
    [
      ['condition:0', '1'],
      ['condition:1', '2'],
      ['error:0', 'Timeout'],
      ['error:1', 'No match'],
      ['error:2', 'Error'],
    ],
  );
  const hours = findAction(sample(), id(3))!;
  assert.deepEqual(getOutputs(hours).map((o) => o.label), ['In hours', 'Out of hours', 'Error']);
});

test('condition labels', () => {
  assert.equal(conditionLabel('Compare', { Operator: 'Equals', Operands: ['gold'] }), '= gold');
  assert.equal(conditionLabel('Compare', { Operator: 'NumberGreaterThan', Operands: ['5'] }), '> 5');
  assert.equal(conditionLabel('Loop', { Operator: 'Equals', Operands: ['DoneLooping'] }), 'Complete');
});

test('summaries prefer friendly names from metadata', () => {
  const flow = sample();
  assert.equal(summarizeAction(findAction(flow, id(7))!, flow.Metadata!.ActionMetadata![id(7)]), 'Queue: Sales');
  assert.equal(summarizeAction(findAction(flow, id(5))!), 'department = sales');
  assert.match(summarizeAction(findAction(flow, id(10))!), /^We are currently closed/);
});

test('deleting a block clears transitions that pointed at it', () => {
  const flow = sample();
  deleteActions(flow, [id(11)]);
  assert.equal(findAction(flow, id(11)), undefined);
  assert.equal(flow.Metadata!.ActionMetadata![id(11)], undefined);
  const prompt = findAction(flow, id(10))!;
  assert.equal(prompt.Transitions!.NextAction, '');
  const issues = validateFlow(flow);
  assert.ok(issues.some((i) => i.actionId === id(10) && i.severity === 'warning'));
  assert.ok(!issues.some((i) => i.severity === 'error'));
});

test('deleting the start block clears StartAction', () => {
  const flow = sample();
  deleteActions(flow, [id(1), ENTRY_ID]);
  assert.equal(flow.StartAction, '');
  assert.ok(validateFlow(flow).some((i) => i.severity === 'error' && /no start block/.test(i.message)));
});

test('setOutputTarget handles entry, next, condition and error outputs', () => {
  const flow = sample();
  setOutputTarget(flow, ENTRY_ID, 'next', id(3));
  assert.equal(flow.StartAction, id(3));
  setOutputTarget(flow, id(4), 'condition:1', id(11));
  assert.equal(findAction(flow, id(4))!.Transitions!.Conditions![1].NextAction, id(11));
  setOutputTarget(flow, id(4), 'error:0', undefined);
  assert.equal(findAction(flow, id(4))!.Transitions!.Errors![0].NextAction, '');
  setOutputTarget(flow, id(1), 'next', id(10));
  assert.equal(findAction(flow, id(1))!.Transitions!.NextAction, id(10));
});

test('duplicate remaps internal transitions and keeps external ones', () => {
  const flow = sample();
  const copies = duplicateActions(flow, [id(5), id(7)]);
  assert.equal(copies.length, 2);
  const [attrCopy, queueCopy] = copies.map((c) => findAction(flow, c)!);
  assert.equal(attrCopy.Transitions!.NextAction, queueCopy.Identifier);
  assert.equal(queueCopy.Transitions!.NextAction, id(9));
  assert.deepEqual(flow.Metadata!.ActionMetadata![queueCopy.Identifier].position, { x: 1790, y: 80 });
  assert.deepEqual(flow.Metadata!.ActionMetadata![queueCopy.Identifier].parameters, { QueueId: { displayName: 'Sales' } });
});

test('branches can be added and removed', () => {
  const flow = sample();
  addBranch(flow, id(4), 'condition', '3');
  addBranch(flow, id(4), 'error', 'CallFailed');
  const action = findAction(flow, id(4))!;
  assert.equal(action.Transitions!.Conditions!.length, 3);
  assert.equal(action.Transitions!.Errors!.length, 4);
  removeBranch(flow, id(4), 'condition:0');
  assert.deepEqual(action.Transitions!.Conditions![0].Condition.Operands, ['2']);
});

test('every catalog block creates a well-formed action', () => {
  for (const block of BLOCKS) {
    const action = createAction(block.type);
    assert.equal(action.Type, block.type);
    assert.ok(action.Identifier.length >= 32);
    const outputs = getOutputs(action);
    assert.equal(outputs.filter((o) => o.kind === 'next').length, block.hasNext ? 1 : 0, block.type);
    assert.equal(outputs.filter((o) => o.kind === 'error').length, block.defaultErrors.length);
  }
  assert.equal(getBlockLabel('SomeFutureBlockType'), 'Some Future Block Type');
});

test('new flow is valid and connected', () => {
  const flow = newFlow('Test');
  assert.deepEqual(validateFlow(flow), []);
  assert.equal(reachableFrom(flow, flow.StartAction).size, 2);
});

test('auto layout places blocks left to right by depth', () => {
  const flow = sample();
  const layout = autoLayout(flow);
  assert.equal(layout.size, 12);
  assert.ok(layout.get(id(1))!.x < layout.get(id(2))!.x);
  assert.ok(layout.get(id(2))!.x < layout.get(id(3))!.x);
  const columns = new Map<number, number[]>();
  for (const [key, p] of layout) {
    if (key !== ENTRY_ID) {
      columns.set(p.x, [...(columns.get(p.x) ?? []), p.y]);
    }
  }
  for (const ys of columns.values()) {
    assert.equal(new Set(ys).size, ys.length, 'no two blocks share a slot');
  }
});

/** a -> b -> c, with c's error branch going back to a and b's error branch to d. */
function loopFlow(): ContactFlow {
  const flow: ContactFlow = { Version: '2019-10-30', StartAction: 'a', Actions: [] };
  for (const name of ['a', 'b', 'c', 'd']) {
    addAction(flow, createAction(name === 'd' ? 'DisconnectParticipant' : 'GetParticipantInput', name), { x: 0, y: 0 });
  }
  setOutputTarget(flow, 'a', 'next', 'b');
  setOutputTarget(flow, 'b', 'next', 'c');
  setOutputTarget(flow, 'b', 'error:0', 'd');
  setOutputTarget(flow, 'c', 'next', 'd');
  setOutputTarget(flow, 'c', 'error:0', 'a');
  return flow;
}

test('finds loop transitions', () => {
  const flow = loopFlow();
  assert.deepEqual([...findLoopEdges(flow)], [edgeKey('c', 'error:0')]);
  assert.equal(findLoopEdges(sample()).size, 0);
});

test('auto layout points every non-loop connection forwards', () => {
  for (const flow of [sample(), loopFlow()]) {
    const layout = autoLayout(flow);
    const loops = findLoopEdges(flow);
    for (const action of flow.Actions) {
      for (const o of getOutputs(action)) {
        if (o.target && !loops.has(edgeKey(action.Identifier, o.key))) {
          assert.ok(layout.get(action.Identifier)!.x < layout.get(o.target)!.x, `${action.Identifier} -> ${o.target}`);
        }
      }
    }
  }
  // d is reached from b and c, so it goes after c (longest path), not next to c.
  const layout = autoLayout(loopFlow());
  assert.ok(layout.get('c')!.x < layout.get('d')!.x);
});

test('reachingTo lists every block that leads to a block', () => {
  const flow = loopFlow();
  assert.deepEqual([...reachingTo(flow, 'd')].sort(), ['a', 'b', 'c', 'd']);
  setOutputTarget(flow, 'c', 'error:0', undefined);
  assert.deepEqual([...reachingTo(flow, 'b')].sort(), ['a', 'b']);
});

test('linked flows and richer summaries', () => {
  const transfer = createAction('TransferToFlow', 't');
  transfer.Parameters = { ContactFlowId: 'arn:aws:connect:us-east-1:1:instance/i/contact-flow/abc' };
  assert.deepEqual(linkedFlowRef(transfer, { parameters: { ContactFlowId: { displayName: 'Billing' } } }), {
    reference: 'arn:aws:connect:us-east-1:1:instance/i/contact-flow/abc',
    name: 'Billing',
    kind: 'flow',
  });
  assert.equal(linkedFlowRef(transfer)!.name, 'abc');
  const module = createAction('InvokeFlowModule', 'm');
  module.Parameters = { FlowModuleId: 'mod-1' };
  assert.equal(linkedFlowRef(module)!.kind, 'module');
  assert.equal(linkedFlowRef(createAction('DisconnectParticipant')), undefined);

  const compare = createAction('Compare');
  compare.Parameters = { ComparisonValue: '$.Channel' };
  assert.equal(summarizeAction(compare), 'Checks $.Channel');
  const view = createAction('ShowView');
  view.Parameters = { ViewResource: { Id: 'form' }, ViewData: { Heading: 'New case' } };
  assert.equal(summarizeAction(view), 'View: form · “New case”');
  const ssml = createAction('MessageParticipant');
  ssml.Parameters = { SSML: '<speak>Hello <break time="1s"/> there</speak>' };
  assert.equal(summarizeAction(ssml), 'Hello there');
});

test('ensurePositions fills only missing positions', () => {
  const flow: ContactFlow = { Version: '2019-10-30', StartAction: 'a', Actions: [] };
  addAction(flow, createAction('MessageParticipant', 'a'), { x: 5, y: 5 });
  flow.Actions.push(createAction('DisconnectParticipant', 'b'));
  findAction(flow, 'a')!.Transitions!.NextAction = 'b';
  delete flow.Metadata!.entryPointPosition;
  assert.equal(ensurePositions(flow), true);
  assert.deepEqual(flow.Metadata!.ActionMetadata!.a.position, { x: 5, y: 5 });
  assert.ok(flow.Metadata!.ActionMetadata!.b.position);
  assert.ok(flow.Metadata!.entryPointPosition);
  assert.equal(ensurePositions(flow), false);
});

test('indentation detection and serialization round-trip', () => {
  assert.equal(detectIndent('{"a":1}'), undefined);
  assert.equal(detectIndent('{\n    "a": 1\n}'), '    ');
  assert.equal(detectIndent('{\r\n\t"a": 1\r\n}'), '\t');
  const flow = sample();
  assert.equal(serializeFlow(flow, detectIndent(sampleText)), sampleText.replace(/\r\n/g, '\n'));
  assert.equal(serializeFlow(flow, undefined), JSON.stringify(flow));
  assert.ok(serializeFlow(flow, '  ', '\r\n').includes('\r\n'));
});
