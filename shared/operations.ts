import { operationsProtocolSchema } from './contracts/generated.js';
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
