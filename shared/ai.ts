import { aiLimitsSchema, aiOutputTokensSchema, type AiLimits } from './contracts/generated.js';

const limits = aiLimitsSchema.properties;
export const AI_LIMITS: AiLimits = {
  maxOutputTokens: aiOutputTokensSchema.maximum,
  maxInputBytes: limits.maxInputBytes.const,
  maxOutputBytes: limits.maxOutputBytes.const,
  maxResponseBytes: limits.maxResponseBytes.const,
  requestTimeoutMs: limits.requestTimeoutMs.const,
  jobTimeoutMs: limits.jobTimeoutMs.const,
  maxAttempts: limits.maxAttempts.const,
};
