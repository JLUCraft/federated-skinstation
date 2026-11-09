import { requireThat } from './store.js';

export const DEFAULT_ORGANIZATION = 'jlucraft';

export function resolveOrganization(value: string | undefined): string {
  const organization = value === undefined ? DEFAULT_ORGANIZATION : value;
  requireThat(
    typeof organization === 'string' && /^[a-z0-9-]{1,64}$/.test(organization),
    'Organization must contain 1–64 lowercase letters, digits, or hyphens',
  );
  return organization;
}
