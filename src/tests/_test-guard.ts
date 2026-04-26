/**
 * Hard guard against running destructive test cleanup against the production DB.
 * Every E2E test file that wipes tables must call assertTestDatabase() before
 * the wipe runs.
 *
 * 2026-04-25: a test cleanAll() ran against prod and deleted Eric's data.
 * Never again — the only escape hatch is an explicit env override.
 */
export function assertTestDatabase(): void {
  const url = process.env.DATABASE_URL || '';
  const m = url.match(/\/([^/?]+)(\?|$)/);
  const dbName = m?.[1] || '<unknown>';
  const looksLikeTest = /test/i.test(dbName);
  const override = process.env.ALLOW_PROD_DB_WIPE === 'i_understand_the_risk';
  if (!looksLikeTest && !override) {
    console.error('\n========================================================');
    console.error(' ABORT: refusing to run destructive test cleanup against');
    console.error(` a non-test database. DATABASE_URL points to: "${dbName}"`);
    console.error('');
    console.error(' Options:');
    console.error('  1. Create a test DB and point DATABASE_URL there:');
    console.error('       createdb loyalty_test');
    console.error('       DATABASE_URL=postgresql://.../loyalty_test \\');
    console.error('         npx prisma migrate deploy');
    console.error('       DATABASE_URL=postgresql://.../loyalty_test \\');
    console.error('         npx tsx src/tests/<file>.test.ts');
    console.error('');
    console.error('  2. Override (only when you know the DB is throwaway):');
    console.error('       ALLOW_PROD_DB_WIPE=i_understand_the_risk \\');
    console.error('         npx tsx src/tests/<file>.test.ts');
    console.error('========================================================\n');
    process.exit(1);
  }
}
