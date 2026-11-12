import {
  activityLimitsSchema,
  pointAmountSchema,
  pointLimitSchema,
  type ActivityLimits,
} from './contracts/generated.js';

export const ACTIVITY_LIMITS: ActivityLimits = {
  sliceMs: activityLimitsSchema.properties.sliceMs.const,
  dayMs: activityLimitsSchema.properties.dayMs.const,
  maxBatchSlices: activityLimitsSchema.properties.maxBatchSlices.const,
  maxPlayers: activityLimitsSchema.properties.maxPlayers.const,
  weightDenominator: activityLimitsSchema.properties.weightDenominator.const,
  maxWeightBps: activityLimitsSchema.properties.maxWeightBps.const,
};
export const POINT_LIMIT = BigInt(pointLimitSchema.const);
const pattern = new RegExp(pointAmountSchema.pattern);

export function pointAmount(value: string): bigint | undefined {
  if (!pattern.test(value)) return undefined;
  const amount = BigInt(value);
  return amount <= POINT_LIMIT ? amount : undefined;
}
