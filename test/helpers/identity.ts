import { LocalIdentity } from '../../server/permissions.js';
import type { Store } from '../../server/store.js';

export function authority(store: Store, admins: readonly string[]) {
  const identity = new LocalIdentity(store);
  const schools = Object.fromEntries(
    store.db.prepare('SELECT DISTINCT school FROM accounts').all()
      .map(row => [String(row.school), { emailDomains: ['school.test'] }]),
  );
  identity.configureSchools(schools);
  for (const row of store.db.prepare('SELECT id FROM accounts').all())
    identity.enrollVerifiedEmail(String(row.id), schools);
  identity.seedAdmins(admins, []);
  return identity;
}
