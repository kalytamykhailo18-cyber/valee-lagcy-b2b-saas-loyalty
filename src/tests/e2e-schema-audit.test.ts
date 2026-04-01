import dotenv from 'dotenv'; dotenv.config();
import prisma from '../db/client.js';

let pass = 0, fail = 0;
function assert(ok: boolean, msg: string) {
  if (ok) { console.log(`  OK  ${msg}`); pass++; }
  else { console.log(`  FAIL ${msg}`); fail++; }
}

async function getColumns(table: string) {
  const rows = await prisma.$queryRaw<any[]>`
    SELECT column_name, data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${table}
    ORDER BY ordinal_position
  `;
  return rows;
}

async function getIndexes(table: string) {
  const rows = await prisma.$queryRaw<any[]>`
    SELECT indexname, indexdef FROM pg_indexes WHERE tablename = ${table}
  `;
  return rows;
}

async function getConstraints(table: string) {
  const rows = await prisma.$queryRaw<any[]>`
    SELECT conname, contype, pg_get_constraintdef(oid) as def
    FROM pg_constraint WHERE conrelid = ${table}::regclass
  `;
  return rows;
}

async function getTriggers(table: string) {
  const rows = await prisma.$queryRaw<any[]>`
    SELECT tgname FROM pg_trigger WHERE tgrelid = ${table}::regclass AND tgname LIKE 'trg_%'
  `;
  return rows;
}

function hasCol(cols: any[], name: string) { return cols.some(c => c.column_name === name); }
function colNullable(cols: any[], name: string) { return cols.find(c => c.column_name === name)?.is_nullable === 'YES'; }
function colNotNull(cols: any[], name: string) { return cols.find(c => c.column_name === name)?.is_nullable === 'NO'; }

async function test() {
  console.log('=== FULL SCHEMA AUDIT: database.md vs PostgreSQL vs Prisma ===\n');

  // ── 1. tenants ──
  console.log('TABLE: tenants');
  const tenants = await getColumns('tenants');
  assert(hasCol(tenants, 'id') && colNotNull(tenants, 'id'), 'id UUID NOT NULL');
  assert(hasCol(tenants, 'name') && colNotNull(tenants, 'name'), 'name NOT NULL');
  assert(hasCol(tenants, 'slug') && colNotNull(tenants, 'slug'), 'slug NOT NULL');
  assert(hasCol(tenants, 'status') && colNotNull(tenants, 'status'), 'status NOT NULL');
  assert(hasCol(tenants, 'owner_email') && colNotNull(tenants, 'owner_email'), 'owner_email NOT NULL');
  assert(hasCol(tenants, 'qr_code_url') && colNullable(tenants, 'qr_code_url'), 'qr_code_url NULL');
  assert(hasCol(tenants, 'created_at') && colNotNull(tenants, 'created_at'), 'created_at NOT NULL');
  assert(hasCol(tenants, 'updated_at') && colNotNull(tenants, 'updated_at'), 'updated_at NOT NULL');
  const tIdx = await getIndexes('tenants');
  assert(tIdx.some(i => i.indexdef.includes('UNIQUE') && i.indexdef.includes('slug')), 'slug UNIQUE index');

  // ── 2. branches ──
  console.log('\nTABLE: branches');
  const branches = await getColumns('branches');
  assert(hasCol(branches, 'id') && hasCol(branches, 'tenant_id') && hasCol(branches, 'name'), 'id, tenant_id, name exist');
  assert(hasCol(branches, 'address') && colNullable(branches, 'address'), 'address NULL');
  assert(hasCol(branches, 'latitude') && hasCol(branches, 'longitude'), 'lat/lon exist');
  assert(hasCol(branches, 'qr_code_url') && hasCol(branches, 'active'), 'qr_code_url, active exist');
  const bIdx = await getIndexes('branches');
  assert(bIdx.some(i => i.indexdef.includes('tenant_id')), '(tenant_id) index');
  assert(bIdx.some(i => i.indexdef.includes('tenant_id') && i.indexdef.includes('active')), '(tenant_id, active) index');

  // ── 3. asset_types ──
  console.log('\nTABLE: asset_types');
  const at = await getColumns('asset_types');
  assert(hasCol(at, 'name') && hasCol(at, 'unit_label') && hasCol(at, 'default_conversion_rate'), 'name, unit_label, rate exist');
  const atIdx = await getIndexes('asset_types');
  assert(atIdx.some(i => i.indexdef.includes('UNIQUE') && i.indexdef.includes('name')), 'name UNIQUE');

  // ── 4. tenant_asset_config ──
  console.log('\nTABLE: tenant_asset_config');
  const tac = await getColumns('tenant_asset_config');
  assert(hasCol(tac, 'tenant_id') && hasCol(tac, 'asset_type_id') && hasCol(tac, 'conversion_rate'), 'tenant_id, asset_type_id, rate');
  const tacIdx = await getIndexes('tenant_asset_config');
  assert(tacIdx.some(i => i.indexdef.includes('UNIQUE') && i.indexdef.includes('tenant_id') && i.indexdef.includes('asset_type_id')), '(tenant_id, asset_type_id) UNIQUE');

  // ── 5. accounts ──
  console.log('\nTABLE: accounts');
  const acc = await getColumns('accounts');
  assert(hasCol(acc, 'phone_number') && colNullable(acc, 'phone_number'), 'phone_number NULL (system accounts)');
  assert(hasCol(acc, 'cedula') && colNullable(acc, 'cedula'), 'cedula NULL');
  assert(hasCol(acc, 'account_type') && colNotNull(acc, 'account_type'), 'account_type NOT NULL');
  assert(hasCol(acc, 'system_account_type') && colNullable(acc, 'system_account_type'), 'system_account_type NULL');
  const accIdx = await getIndexes('accounts');
  assert(accIdx.some(i => i.indexdef.includes('UNIQUE') && i.indexdef.includes('tenant_id') && i.indexdef.includes('phone_number')), '(tenant_id, phone_number) UNIQUE');
  assert(accIdx.some(i => i.indexdef.includes('UNIQUE') && i.indexdef.includes('tenant_id') && i.indexdef.includes('cedula')), '(tenant_id, cedula) UNIQUE');
  assert(accIdx.some(i => i.indexdef.includes('UNIQUE') && i.indexdef.includes('tenant_id') && i.indexdef.includes('system_account_type')), '(tenant_id, system_account_type) UNIQUE');

  // ── 6. ledger_entries ──
  console.log('\nTABLE: ledger_entries');
  const le = await getColumns('ledger_entries');
  const leSpec = ['id','tenant_id','event_type','entry_type','account_id','paired_entry_id','amount',
    'asset_type_id','reference_id','reference_type','branch_id','latitude','longitude',
    'device_id','status','prev_hash','hash','metadata','created_at'];
  for (const col of leSpec) assert(hasCol(le, col), `${col} exists`);
  assert(colNotNull(le, 'amount'), 'amount NOT NULL');
  assert(colNotNull(le, 'hash'), 'hash NOT NULL');
  assert(colNullable(le, 'prev_hash'), 'prev_hash NULL');

  const leC = await getConstraints('ledger_entries');
  assert(leC.some(c => c.def?.includes('amount') && c.def?.includes('> ')), 'CHECK amount > 0');
  const leIdx = await getIndexes('ledger_entries');
  assert(leIdx.some(i => i.indexdef.includes('UNIQUE') && i.indexdef.includes('reference_id') && i.indexdef.includes('entry_type')), '(tenant_id, reference_id, entry_type) UNIQUE');
  assert(leIdx.some(i => i.indexdef.includes('account_id') && !i.indexdef.includes('UNIQUE')), '(tenant_id, account_id) index');
  assert(leIdx.some(i => i.indexdef.includes('event_type')), '(tenant_id, event_type) index');
  assert(leIdx.some(i => i.indexdef.includes('created_at') && !i.indexdef.includes('UNIQUE')), '(tenant_id, created_at) index');
  assert(leIdx.some(i => i.indexdef.includes('status') && !i.indexdef.includes('UNIQUE')), '(tenant_id, status) index');

  const leTrg = await getTriggers('ledger_entries');
  assert(leTrg.some(t => t.tgname === 'trg_ledger_no_update'), 'BEFORE UPDATE trigger');
  assert(leTrg.some(t => t.tgname === 'trg_ledger_no_delete'), 'BEFORE DELETE trigger');
  assert(leTrg.some(t => t.tgname === 'trg_ledger_no_truncate'), 'BEFORE TRUNCATE trigger');

  // ── 7. invoices ──
  console.log('\nTABLE: invoices');
  const inv = await getColumns('invoices');
  const invSpec = ['id','tenant_id','branch_id','invoice_number','amount','transaction_date',
    'customer_phone','status','source','upload_batch_id','consumer_account_id','ledger_entry_id',
    'ocr_raw_text','extracted_data','confidence_score','submitted_latitude','submitted_longitude',
    'rejection_reason','created_at','updated_at'];
  for (const col of invSpec) assert(hasCol(inv, col), `${col} exists`);

  // ── 8. upload_batches ──
  console.log('\nTABLE: upload_batches');
  const ub = await getColumns('upload_batches');
  const ubSpec = ['id','tenant_id','filename','file_url','status','rows_loaded','rows_skipped',
    'rows_errored','error_details','uploaded_by_staff_id','created_at','completed_at'];
  for (const col of ubSpec) assert(hasCol(ub, col), `${col} exists`);

  // ── 9. redemption_tokens ──
  console.log('\nTABLE: redemption_tokens');
  const rt = await getColumns('redemption_tokens');
  const rtSpec = ['id','tenant_id','consumer_account_id','product_id','amount','asset_type_id',
    'status','token_signature','expires_at','used_at','used_by_staff_id','branch_id',
    'ledger_pending_entry_id','created_at'];
  for (const col of rtSpec) assert(hasCol(rt, col), `${col} exists`);

  // ── 10. products ──
  console.log('\nTABLE: products');
  const prod = await getColumns('products');
  const prodSpec = ['id','tenant_id','name','description','photo_url','redemption_cost',
    'asset_type_id','stock','active','created_at','updated_at'];
  for (const col of prodSpec) assert(hasCol(prod, col), `${col} exists`);
  const prodC = await getConstraints('products');
  assert(prodC.some(c => c.def?.includes('redemption_cost') && c.def?.includes('> ')), 'CHECK redemption_cost > 0');
  assert(prodC.some(c => c.def?.includes('stock') && c.def?.includes('>= ')), 'CHECK stock >= 0');

  // ── 11. staff ──
  console.log('\nTABLE: staff');
  const st = await getColumns('staff');
  const stSpec = ['id','tenant_id','branch_id','name','email','password_hash','role','active','created_at','updated_at'];
  for (const col of stSpec) assert(hasCol(st, col), `${col} exists`);
  const stIdx = await getIndexes('staff');
  assert(stIdx.some(i => i.indexdef.includes('UNIQUE') && i.indexdef.includes('tenant_id') && i.indexdef.includes('email')), '(tenant_id, email) UNIQUE');

  // ── 12. admin_users ──
  console.log('\nTABLE: admin_users');
  const au = await getColumns('admin_users');
  const auSpec = ['id','name','email','password_hash','active','created_at'];
  for (const col of auSpec) assert(hasCol(au, col), `${col} exists`);
  const auIdx = await getIndexes('admin_users');
  assert(auIdx.some(i => i.indexdef.includes('UNIQUE') && i.indexdef.includes('email')), 'email UNIQUE');

  // ── 13. audit_log ──
  console.log('\nTABLE: audit_log');
  const al = await getColumns('audit_log');
  const alSpec = ['id','tenant_id','actor_id','actor_type','actor_role','action_type',
    'consumer_account_id','amount','outcome','failure_reason','metadata','created_at'];
  for (const col of alSpec) assert(hasCol(al, col), `${col} exists`);
  const alTrg = await getTriggers('audit_log');
  assert(alTrg.some(t => t.tgname === 'trg_audit_no_update'), 'BEFORE UPDATE trigger');
  assert(alTrg.some(t => t.tgname === 'trg_audit_no_delete'), 'BEFORE DELETE trigger');
  assert(alTrg.some(t => t.tgname === 'trg_audit_no_truncate'), 'BEFORE TRUNCATE trigger');

  // ── 14. disputes ──
  console.log('\nTABLE: disputes');
  const disp = await getColumns('disputes');
  const dispSpec = ['id','tenant_id','consumer_account_id','description','screenshot_url',
    'status','resolver_id','resolver_type','resolution_reason','ledger_adjustment_entry_id',
    'created_at','resolved_at'];
  for (const col of dispSpec) assert(hasCol(disp, col), `${col} exists`);

  // ── 15. idempotency_keys ──
  console.log('\nTABLE: idempotency_keys');
  const ik = await getColumns('idempotency_keys');
  const ikSpec = ['id','key','resource_type','result','expires_at','created_at','tenant_id'];
  for (const col of ikSpec) assert(hasCol(ik, col), `${col} exists`);
  const ikIdx = await getIndexes('idempotency_keys');
  assert(ikIdx.some(i => i.indexdef.includes('UNIQUE') && i.indexdef.includes('key')), 'key UNIQUE');
  assert(ikIdx.some(i => i.indexdef.includes('expires_at')), '(expires_at) index');

  // ── 16. otp_sessions ──
  console.log('\nTABLE: otp_sessions');
  const otp = await getColumns('otp_sessions');
  const otpSpec = ['id','phone_number','otp_hash','expires_at','used','created_at','tenant_id'];
  for (const col of otpSpec) assert(hasCol(otp, col), `${col} exists`);

  // ── RLS ──
  console.log('\nROW-LEVEL SECURITY');
  const rls = await prisma.$queryRaw<any[]>`
    SELECT tablename, rowsecurity FROM pg_tables WHERE schemaname = 'public' AND rowsecurity = true ORDER BY tablename
  `;
  const rlsTables = rls.map((r: any) => r.tablename);
  const expectedRLS = ['tenants','branches','accounts','ledger_entries','invoices','upload_batches',
    'redemption_tokens','products','staff','audit_log','disputes','tenant_asset_config',
    'idempotency_keys','otp_sessions'];
  for (const t of expectedRLS) assert(rlsTables.includes(t), `RLS enabled on ${t}`);

  console.log(`\n=== SCHEMA AUDIT: ${pass} passed, ${fail} failed ===\n`);
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}
test();
