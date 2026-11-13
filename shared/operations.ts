import {
  operationsProtocolSchema,
  operationsSensitiveActionSchema,
  operationsGlobalActionSchema,
  type OperationsOperation,
} from './contracts/generated.js';
const protocol = operationsProtocolSchema.properties;
export const OPERATIONS_LEASE_SECONDS = protocol.leaseSeconds.const;
export const OPERATIONS_MAX_REQUEST_BYTES = protocol.maxRequestBytes.const;
export const OPERATIONS_PATH = protocol.controlPath.const;
export const EXECUTOR_SNAPSHOT_PATH = protocol.snapshotPath.const;
export const EXECUTOR_JOBS_PATH = protocol.jobsPath.const;

export const EXECUTOR_INSTANCES_PATH = protocol.instancesPath.const;
export const OPERATIONS_MAX_PAGE_ROWS = protocol.maxPageRows.const;
export const OPERATIONS_WATCH_SECONDS = protocol.watchSeconds.const;
export const OPERATIONS_SCOPE_HEADER = protocol.scopeHeader.const;

export const OPERATIONS_APPROVAL_SECONDS = protocol.approvalSeconds.const;
export const OPERATIONS_CLAIM_PATH = protocol.claimPath.const;
export const OPERATIONS_APPROVAL_PATH = OPERATIONS_PATH + '/approvals';
export function operationNeedsApproval(operation: OperationsOperation) {
  return operationsSensitiveActionSchema.enum.some((action) => action === operation.action);
}
export function operationRequiresGlobal(operation: OperationsOperation) {
  return operationsGlobalActionSchema.enum.some((action) => action === operation.action);
}
export function operationPermission(operation: OperationsOperation): 'write' | 'manage' {
  return operationNeedsApproval(operation) || operation.action === 'provision' ? 'manage' : 'write';
}

export const OPERATIONS_CLAIM_HEADER = protocol.claimHeader.const;
