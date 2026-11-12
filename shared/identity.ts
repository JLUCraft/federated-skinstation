import { identitySnapshotSchema } from './contracts/generated.js';

export const PASSWORD_RULES = identitySnapshotSchema.definitions.Password;
export const RECOVERY_EMAIL_MAX_LENGTH =
  identitySnapshotSchema.definitions.RecoveryRequest.properties.email.maxLength;
