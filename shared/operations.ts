import { operationsProtocolSchema } from './contracts/generated.js';
const protocol = operationsProtocolSchema.properties;
export const OPERATIONS_LEASE_SECONDS = protocol.leaseSeconds.const;
export const OPERATIONS_MAX_REQUEST_BYTES = protocol.maxRequestBytes.const;
export const OPERATIONS_PATH = protocol.controlPath.const;
export const EXECUTOR_SNAPSHOT_PATH = protocol.snapshotPath.const;
export const EXECUTOR_JOBS_PATH = protocol.jobsPath.const;
