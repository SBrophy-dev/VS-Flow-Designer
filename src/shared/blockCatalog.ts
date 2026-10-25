// Catalog of Amazon Connect flow block types: display names, palette categories and the
// defaults used when a block is added from the palette. Unknown types still render generically.

export type BlockCategory = 'Interact' | 'Set' | 'Branch' | 'Integrate' | 'Logic' | 'Terminate';

export interface ConditionTemplate {
  Operator: string;
  Operands: string[];
}

export interface BlockDefinition {
  type: string;
  label: string;
  category: BlockCategory;
  description: string;
  /** Whether the block has a default "Success"/next transition. */
  hasNext: boolean;
  defaultParameters: Record<string, unknown>;
  defaultErrors: string[];
  defaultConditions: ConditionTemplate[];
  /** Hide from the palette (for example blocks that only exist in modules). */
  hidden?: boolean;
}

export const CATEGORY_ORDER: BlockCategory[] = ['Interact', 'Set', 'Branch', 'Integrate', 'Logic', 'Terminate'];

export const CATEGORY_COLORS: Record<BlockCategory, string> = {
  Interact: '#2e7dd7',
  Set: '#8a5cd6',
  Branch: '#d68a1f',
  Integrate: '#1f9e8a',
  Logic: '#6b7a90',
  Terminate: '#d0455b',
};

const def = (
  type: string,
  label: string,
  category: BlockCategory,
  description: string,
  opts: Partial<Omit<BlockDefinition, 'type' | 'label' | 'category' | 'description'>> = {},
): BlockDefinition => ({
  type,
  label,
  category,
  description,
  hasNext: opts.hasNext ?? true,
  defaultParameters: opts.defaultParameters ?? {},
  defaultErrors: opts.defaultErrors ?? ['NoMatchingError'],
  defaultConditions: opts.defaultConditions ?? [],
  hidden: opts.hidden,
});

export const BLOCKS: BlockDefinition[] = [
  // Interact
  def('MessageParticipant', 'Play prompt', 'Interact', 'Play a text-to-speech or audio prompt, or send a chat message.', {
    defaultParameters: { Text: 'Thank you for calling.' },
  }),
  def('GetParticipantInput', 'Get customer input', 'Interact', 'Play a prompt and branch on the DTMF keys the customer presses.', {
    hasNext: false,
    defaultParameters: { Text: 'Press 1 for sales or 2 for support.', StoreInput: 'False', InputTimeLimitSeconds: '5' },
    defaultConditions: [
      { Operator: 'Equals', Operands: ['1'] },
      { Operator: 'Equals', Operands: ['2'] },
    ],
    defaultErrors: ['InputTimeLimitExceeded', 'NoMatchingCondition', 'NoMatchingError'],
  }),
  def('ConnectParticipantWithLexBot', 'Get customer input (Lex)', 'Interact', 'Hand the conversation to an Amazon Lex bot and branch on the intent.', {
    hasNext: false,
    defaultParameters: { Text: 'How can I help you today?', LexV2Bot: { AliasArn: '' } },
    defaultConditions: [{ Operator: 'Equals', Operands: ['IntentName'] }],
    defaultErrors: ['NoMatchingCondition', 'NoMatchingError'],
  }),
  def('StoreUserInput', 'Store customer input', 'Interact', 'Collect a number from the customer and store it in a system attribute.', {
    defaultParameters: { Text: 'Please enter your account number followed by pound.', CustomerInputType: 'Custom', InputTimeLimitSeconds: '8', DTMFConfiguration: { DisableCancelKey: 'False', InputTerminationSequence: '#' } },
    defaultErrors: ['InvalidPhoneNumber', 'NoMatchingError'],
  }),
  def('MessageParticipantIteratively', 'Loop prompts', 'Interact', 'Play a sequence of prompts repeatedly while the customer waits in queue.', {
    hasNext: false,
    defaultParameters: { Messages: [{ Text: 'Your call is important to us.' }], InterruptFrequencySeconds: '60' },
    defaultErrors: ['NoMatchingError'],
  }),
  def('ShowView', 'Show view', 'Interact', 'Show a step-by-step guide or form to the agent or customer.', {
    hasNext: false,
    defaultParameters: { ViewResource: { Id: '' }, InvocationTimeLimitSeconds: '300' },
    defaultConditions: [{ Operator: 'Equals', Operands: ['Back'] }, { Operator: 'Equals', Operands: ['Next'] }],
    defaultErrors: ['NoMatchingCondition', 'NoMatchingError', 'TimeLimitExceeded'],
  }),

  // Set
  def('UpdateContactAttributes', 'Set contact attributes', 'Set', 'Store key/value pairs on the contact.', {
    defaultParameters: { Attributes: { key: 'value' }, TargetContact: 'Current' },
  }),
  def('UpdateContactTargetQueue', 'Set working queue', 'Set', 'Choose the queue the contact is transferred to.', {
    defaultParameters: { QueueId: 'arn:aws:connect:region:account:instance/instance-id/queue/queue-id' },
  }),
  def('UpdateContactTextToSpeechVoice', 'Set voice', 'Set', 'Choose the Amazon Polly voice and language used for prompts.', {
    defaultParameters: { TextToSpeechVoice: 'Joanna' },
  }),
  def('UpdateFlowLoggingBehavior', 'Set logging behavior', 'Set', 'Turn flow logs in Amazon CloudWatch on or off.', {
    defaultParameters: { FlowLoggingBehavior: 'Enabled' },
    defaultErrors: [],
  }),
  def('UpdateContactRecordingBehavior', 'Set recording and analytics behavior', 'Set', 'Turn call recording and Contact Lens analytics on or off.', {
    defaultParameters: { RecordingBehavior: { RecordedParticipants: ['Agent', 'Customer'] } },
    defaultErrors: [],
  }),
  def('UpdateContactEventHooks', 'Set event flow', 'Set', 'Set the customer queue, hold, whisper or disconnect flow.', {
    defaultParameters: { EventHooks: { CustomerQueue: 'arn:aws:connect:region:account:instance/instance-id/contact-flow/flow-id' } },
  }),
  def('UpdateContactRoutingBehavior', 'Change routing priority / age', 'Set', 'Change the priority or age of the contact in queue.', {
    defaultParameters: { QueuePriority: '1' },
  }),
  def('UpdateContactData', 'Set contact data', 'Set', 'Update contact properties such as language, name or description.', {
    defaultParameters: { LanguageCode: 'en-US' },
  }),
  def('UpdateContactCallbackNumber', 'Set callback number', 'Set', 'Set the number used for queued callbacks.', {
    defaultParameters: { CallbackNumber: '$.CustomerEndpoint.Address' },
    defaultErrors: ['InvalidPhoneNumber', 'NoMatchingError'],
  }),
  def('UpdateContactMediaStreamingBehavior', 'Start/stop media streaming', 'Set', 'Stream customer audio to Amazon Kinesis Video Streams.', {
    defaultParameters: { MediaStreamingState: 'Enabled', MediaStream: { AudioSource: 'Customer' } },
  }),
  def('TagContact', 'Tag contact', 'Set', 'Add user-defined tags to the contact.', {
    defaultParameters: { Tags: { key: 'value' } },
  }),

  // Branch
  def('Compare', 'Check contact attributes', 'Branch', 'Branch on the value of a contact attribute.', {
    hasNext: false,
    defaultParameters: { ComparisonValue: '$.Attributes.key' },
    defaultConditions: [{ Operator: 'Equals', Operands: ['value'] }],
    defaultErrors: ['NoMatchingCondition'],
  }),
  def('CheckHoursOfOperation', 'Check hours of operation', 'Branch', 'Branch on whether the contact arrived inside the configured hours.', {
    hasNext: false,
    defaultParameters: {},
    defaultConditions: [
      { Operator: 'Equals', Operands: ['True'] },
      { Operator: 'Equals', Operands: ['False'] },
    ],
  }),
  def('CheckMetricData', 'Check queue status / staffing', 'Branch', 'Branch on real-time queue metrics or agent staffing.', {
    hasNext: false,
    defaultParameters: { MetricType: 'NumberOfAgentsAvailable' },
    defaultConditions: [{ Operator: 'NumberGreaterThan', Operands: ['0'] }],
    defaultErrors: ['NoMatchingCondition', 'NoMatchingError'],
  }),
  def('DistributeByPercentage', 'Distribute by percentage', 'Branch', 'Route contacts randomly by percentage (A/B testing).', {
    hasNext: false,
    defaultParameters: {},
    defaultConditions: [{ Operator: 'NumberLessThan', Operands: ['50'] }],
    defaultErrors: ['NoMatchingCondition'],
  }),

  // Integrate
  def('InvokeLambdaFunction', 'Invoke AWS Lambda function', 'Integrate', 'Call a Lambda function and use its response in the flow.', {
    defaultParameters: { LambdaFunctionARN: 'arn:aws:lambda:region:account:function:name', InvocationTimeLimitSeconds: '3', ResponseValidation: { ResponseType: 'STRING_MAP' } },
  }),
  def('InvokeFlowModule', 'Invoke module', 'Integrate', 'Run a reusable flow module.', {
    defaultParameters: { FlowModuleId: '' },
  }),
  def('CreateTask', 'Create task', 'Integrate', 'Create an Amazon Connect task.', {
    defaultParameters: { Name: 'Follow up', ContactFlowId: '' },
  }),
  def('GetMetricData', 'Get queue metrics', 'Integrate', 'Read real-time queue metrics into attributes.', {
    defaultParameters: {},
  }),

  // Logic
  def('Loop', 'Loop', 'Logic', 'Repeat a branch a number of times.', {
    hasNext: false,
    defaultParameters: { LoopCount: '3' },
    defaultConditions: [
      { Operator: 'Equals', Operands: ['ContinueLooping'] },
      { Operator: 'Equals', Operands: ['DoneLooping'] },
    ],
    defaultErrors: [],
  }),
  def('Wait', 'Wait', 'Logic', 'Pause the flow for a period of time (chat and tasks).', {
    hasNext: false,
    defaultParameters: { TimeLimitSeconds: '60' },
    defaultErrors: ['TimeLimitExceeded', 'NoMatchingError'],
  }),

  // Terminate / transfer
  def('TransferContactToQueue', 'Transfer to queue', 'Terminate', 'Put the contact in the working queue.', {
    hasNext: false,
    defaultErrors: ['QueueAtCapacity', 'NoMatchingError'],
  }),
  def('TransferToFlow', 'Transfer to flow', 'Terminate', 'Continue in another flow.', {
    hasNext: false,
    defaultParameters: { ContactFlowId: 'arn:aws:connect:region:account:instance/instance-id/contact-flow/flow-id' },
  }),
  def('TransferParticipantToThirdParty', 'Transfer to phone number', 'Terminate', 'Transfer the contact to an external phone number.', {
    defaultParameters: { ThirdPartyPhoneNumber: '+15555550100', ThirdPartyConnectionTimeLimitSeconds: '30', ContinueFlowExecution: 'True' },
    defaultErrors: ['CallFailed', 'ConnectionTimeLimitExceeded', 'NoMatchingError'],
  }),
  def('DisconnectParticipant', 'Disconnect / hang up', 'Terminate', 'End the contact.', {
    hasNext: false,
    defaultErrors: [],
  }),
  def('EndFlowExecution', 'End flow / Resume', 'Terminate', 'Stop running this flow (for example in whisper or queue flows).', {
    hasNext: false,
    defaultErrors: [],
  }),
  def('EndFlowModuleExecution', 'Return (module)', 'Terminate', 'Return from a flow module to the calling flow.', {
    hasNext: false,
    defaultErrors: [],
  }),
];

const byType = new Map(BLOCKS.map((b) => [b.type, b]));

export function getBlockDefinition(type: string): BlockDefinition | undefined {
  return byType.get(type);
}

export function getBlockLabel(type: string): string {
  return byType.get(type)?.label ?? splitCamelCase(type);
}

export function getBlockCategory(type: string): BlockCategory {
  return byType.get(type)?.category ?? 'Logic';
}

export function splitCamelCase(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
}
