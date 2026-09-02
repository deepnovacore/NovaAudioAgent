type Bundle = Record<string, unknown>

const FILE_PARAMS = {
  type: 'object',
  properties: {
    grantRoot: {type: ['string', 'null']},
    itemId: {type: 'string'},
    reason: {type: ['string', 'null']},
    startedAtMs: {type: 'integer'},
    threadId: {type: 'string'},
    turnId: {type: 'string'},
  },
  required: ['itemId', 'startedAtMs', 'threadId', 'turnId'],
}

const COMMAND_DEFINITIONS = {
  CommandExecutionApprovalKind: {
    type: 'string', enum: ['command', 'writeStdin'],
  },
  CommandAction: {
    oneOf: [{
      type: 'object',
      properties: {command: {type: 'string'}, type: {type: 'string', enum: ['unknown']}},
      required: ['command', 'type'],
    }],
  },
  LegacyAppPathString: {type: 'string'},
  NetworkApprovalContext: {
    type: 'object',
    properties: {host: {type: 'string'}, protocol: {type: 'string'}},
    required: ['host', 'protocol'],
  },
  NetworkPolicyAmendment: {
    type: 'object',
    properties: {action: {type: 'string'}, host: {type: 'string'}},
    required: ['action', 'host'],
  },
}

const COMMAND_PARAMS = {
  type: 'object',
  properties: {
    approvalId: {type: ['string', 'null']},
    command: {type: ['string', 'null']},
    commandActions: {
      type: ['array', 'null'], items: {$ref: '#/definitions/CommandAction'},
    },
    cwd: {anyOf: [{$ref: '#/definitions/LegacyAppPathString'}, {type: 'null'}]},
    environmentId: {type: ['string', 'null']},
    itemId: {type: 'string'},
    kind: {
      allOf: [{$ref: '#/definitions/CommandExecutionApprovalKind'}],
      default: 'command',
    },
    networkApprovalContext: {
      anyOf: [{$ref: '#/definitions/NetworkApprovalContext'}, {type: 'null'}],
    },
    proposedExecpolicyAmendment: {type: ['array', 'null'], items: {type: 'string'}},
    proposedNetworkPolicyAmendments: {
      type: ['array', 'null'], items: {$ref: '#/definitions/NetworkPolicyAmendment'},
    },
    reason: {type: ['string', 'null']},
    startedAtMs: {type: 'integer'},
    threadId: {type: 'string'},
    turnId: {type: 'string'},
  },
  required: ['itemId', 'startedAtMs', 'threadId', 'turnId'],
  definitions: COMMAND_DEFINITIONS,
}

function requestVariant(method: string, paramsDefinition: string): unknown {
  return {
    type: 'object',
    properties: {
      id: {$ref: '#/definitions/RequestId'},
      method: {type: 'string', enum: [method]},
      params: {$ref: `#/definitions/${paramsDefinition}`},
    },
    required: ['id', 'method', 'params'],
  }
}

function decision(value: string): unknown {
  return {type: 'string', enum: [value]}
}

function response(decisionName: string, choices: readonly unknown[]): unknown {
  return {
    type: 'object',
    properties: {decision: {$ref: `#/definitions/${decisionName}`}},
    required: ['decision'],
    definitions: {[decisionName]: {oneOf: choices}},
  }
}

function objectDecision(property: string): unknown {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {[property]: {type: 'object'}},
    required: [property],
  }
}

export function approvalSchemaBundle(): Bundle {
  const fileParams = structuredClone(FILE_PARAMS)
  const commandParams = structuredClone(COMMAND_PARAMS)
  const itemStarted = {
    type: 'object',
    properties: {
      item: {$ref: '#/definitions/ThreadItem'},
      startedAtMs: {type: 'integer'},
      threadId: {type: 'string'},
      turnId: {type: 'string'},
    },
    required: ['item', 'startedAtMs', 'threadId', 'turnId'],
    definitions: {
      ThreadItem: {
        oneOf: [{
          type: 'object',
          properties: {
            changes: {type: 'array', items: {$ref: '#/definitions/FileUpdateChange'}},
            id: {type: 'string'},
            status: {$ref: '#/definitions/PatchApplyStatus'},
            type: {type: 'string', enum: ['fileChange']},
          },
          required: ['changes', 'id', 'status', 'type'],
        }],
      },
      FileUpdateChange: {
        type: 'object',
        properties: {
          diff: {type: 'string'},
          kind: {$ref: '#/definitions/PatchChangeKind'},
          path: {type: 'string'},
        },
        required: ['diff', 'kind', 'path'],
      },
      PatchApplyStatus: {
        type: 'string', enum: ['inProgress', 'completed', 'failed', 'declined'],
      },
      PatchChangeKind: {
        oneOf: [
          {
            type: 'object', properties: {type: {type: 'string', enum: ['add']}},
            required: ['type'],
          },
          {
            type: 'object', properties: {type: {type: 'string', enum: ['delete']}},
            required: ['type'],
          },
          {
            type: 'object',
            properties: {
              move_path: {type: ['string', 'null']},
              type: {type: 'string', enum: ['update']},
            },
            required: ['type'],
          },
        ],
      },
    },
  }
  return {
    'ServerRequest.json': {
      oneOf: [
        requestVariant(
          'item/commandExecution/requestApproval',
          'CommandExecutionRequestApprovalParams',
        ),
        requestVariant('item/fileChange/requestApproval', 'FileChangeRequestApprovalParams'),
      ],
      definitions: {
        RequestId: {anyOf: [{type: 'string'}, {type: 'integer'}]},
        FileChangeRequestApprovalParams: structuredClone(FILE_PARAMS),
        CommandExecutionRequestApprovalParams: commandParams,
        ...structuredClone(COMMAND_DEFINITIONS),
      },
    },
    'FileChangeRequestApprovalParams.json': fileParams,
    'CommandExecutionRequestApprovalParams.json': structuredClone(COMMAND_PARAMS),
    'FileChangeRequestApprovalResponse.json': response('FileChangeApprovalDecision', [
      decision('accept'), decision('acceptForSession'), decision('decline'), decision('cancel'),
    ]),
    'CommandExecutionRequestApprovalResponse.json': response(
      'CommandExecutionApprovalDecision',
      [
        decision('accept'),
        decision('acceptForSession'),
        objectDecision('acceptWithExecpolicyAmendment'),
        objectDecision('applyNetworkPolicyAmendment'),
        decision('decline'),
        decision('cancel'),
      ],
    ),
    'v2/ItemStartedNotification.json': itemStarted,
  }
}
