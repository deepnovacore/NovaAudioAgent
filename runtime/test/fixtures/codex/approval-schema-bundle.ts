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

const COMMAND_APPROVAL_DECISIONS = [
  {type: 'string', enum: ['accept']},
  {type: 'string', enum: ['acceptForSession']},
  {
    type: 'object', additionalProperties: false,
    properties: {
      acceptWithExecpolicyAmendment: {
        type: 'object',
        properties: {execpolicy_amendment: {type: 'array', items: {type: 'string'}}},
        required: ['execpolicy_amendment'],
      },
    },
    required: ['acceptWithExecpolicyAmendment'],
  },
  {
    type: 'object', additionalProperties: false,
    properties: {
      applyNetworkPolicyAmendment: {
        type: 'object',
        properties: {
          network_policy_amendment: {
            type: 'object',
            properties: {
              action: {type: 'string', enum: ['allow', 'deny']}, host: {type: 'string'},
            },
            required: ['action', 'host'],
          },
        },
        required: ['network_policy_amendment'],
      },
    },
    required: ['applyNetworkPolicyAmendment'],
  },
  {type: 'string', enum: ['decline']},
  {type: 'string', enum: ['cancel']},
]

const COMMAND_DEFINITIONS = {
  AdditionalPermissionProfile: {type: 'object'},
  CommandExecutionApprovalKind: {
    type: 'string', enum: ['command', 'writeStdin'],
  },
  CommandExecutionApprovalDecision: {oneOf: COMMAND_APPROVAL_DECISIONS},
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
    properties: {action: {type: 'string', enum: ['allow', 'deny']}, host: {type: 'string'}},
    required: ['action', 'host'],
  },
}

const COMMAND_PARAMS = {
  type: 'object',
  properties: {
    additionalPermissions: {
      anyOf: [{$ref: '#/definitions/AdditionalPermissionProfile'}, {type: 'null'}],
    },
    approvalId: {type: ['string', 'null']},
    availableDecisions: {
      type: ['array', 'null'], items: {$ref: '#/definitions/CommandExecutionApprovalDecision'},
    },
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

const PERMISSIONS_PARAMS = {
  type: 'object',
  properties: {
    cwd: {type: 'string'}, environmentId: {type: ['string', 'null']}, itemId: {type: 'string'},
    permissions: {$ref: '#/definitions/RequestPermissionProfile'}, reason: {type: ['string', 'null']},
    startedAtMs: {type: 'integer'}, threadId: {type: 'string'}, turnId: {type: 'string'},
  },
  required: ['cwd', 'itemId', 'permissions', 'startedAtMs', 'threadId', 'turnId'],
  definitions: {RequestPermissionProfile: {type: 'object'}},
}

const PERMISSIONS_RESPONSE = {
  type: 'object',
  properties: {
    permissions: {$ref: '#/definitions/GrantedPermissionProfile'},
    scope: {allOf: [{$ref: '#/definitions/PermissionGrantScope'}]},
    strictAutoReview: {type: ['boolean', 'null']},
  },
  required: ['permissions'],
  definitions: {
    GrantedPermissionProfile: {type: 'object'},
    PermissionGrantScope: {type: 'string', enum: ['turn', 'session']},
  },
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
        requestVariant('item/permissions/requestApproval', 'PermissionsRequestApprovalParams'),
      ],
      definitions: {
        RequestId: {anyOf: [{type: 'string'}, {type: 'integer'}]},
        FileChangeRequestApprovalParams: structuredClone(FILE_PARAMS),
        CommandExecutionRequestApprovalParams: commandParams,
        PermissionsRequestApprovalParams: structuredClone(PERMISSIONS_PARAMS),
        RequestPermissionProfile: {type: 'object'},
        ...structuredClone(COMMAND_DEFINITIONS),
      },
    },
    'FileChangeRequestApprovalParams.json': fileParams,
    'CommandExecutionRequestApprovalParams.json': structuredClone(COMMAND_PARAMS),
    'PermissionsRequestApprovalParams.json': structuredClone(PERMISSIONS_PARAMS),
    'FileChangeRequestApprovalResponse.json': response('FileChangeApprovalDecision', [
      decision('accept'), decision('acceptForSession'), decision('decline'), decision('cancel'),
    ]),
    'CommandExecutionRequestApprovalResponse.json': response(
      'CommandExecutionApprovalDecision',
      structuredClone(COMMAND_APPROVAL_DECISIONS),
    ),
    'PermissionsRequestApprovalResponse.json': structuredClone(PERMISSIONS_RESPONSE),
    'v2/ItemStartedNotification.json': itemStarted,
  }
}
