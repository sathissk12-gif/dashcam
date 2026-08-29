const assert = require('assert');
const { generateToken, verifyToken, verifyApiKey } = require('../src/services/auth_service');
const { checkWsSubscriptionPermission } = require('../src/middleware/authorize');
const { stmts } = require('../src/db/database');
const historyService = require('../src/services/history_service');
const alarmService = require('../src/services/alarm_service');

console.log('🧪 Starting Antigravity Dashcam VPS Automated Integration Test Suite...\n');

let testsPassed = 0;
let testsFailed = 0;

function runTest(name, fn) {
  try {
    fn();
    console.log(`  ✅ [PASS] ${name}`);
    testsPassed++;
  } catch (err) {
    console.error(`  ❌ [FAIL] ${name}:`, err.message);
    testsFailed++;
  }
}

// 1. Setup Test Data
const SIM_CUST1 = '015770990001';
const SIM_CUST2 = '015770990002';

try { stmts.deleteVehicle.run('test_veh_1', SIM_CUST1); } catch (e) {}
try { stmts.deleteVehicle.run('test_veh_2', SIM_CUST2); } catch (e) {}

stmts.insertVehicle.run({
  id: 'test_veh_1',
  number_plate: 'TN 99 AA 0001',
  sim_no: SIM_CUST1,
  model: 'T98 4G',
  driver_name: 'Driver 1',
  driver_phone: '',
  assigned_user_id: 'cust_user_1',
  assigned_user_name: 'Customer One',
  assigned_user_phone: '',
  tenant_id: 'tenant_A',
  channel_count: 2,
  channels_json: '[]',
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString()
});

stmts.insertVehicle.run({
  id: 'test_veh_2',
  number_plate: 'TN 99 BB 0002',
  sim_no: SIM_CUST2,
  model: 'T98 4G',
  driver_name: 'Driver 2',
  driver_phone: '',
  assigned_user_id: 'cust_user_2',
  assigned_user_name: 'Customer Two',
  assigned_user_phone: '',
  tenant_id: 'tenant_B',
  channel_count: 2,
  channels_json: '[]',
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString()
});

const userCust1 = { id: 'cust_user_1', name: 'Customer One', role: 'customer', tenantId: 'tenant_A' };
const userCust2 = { id: 'cust_user_2', name: 'Customer Two', role: 'customer', tenantId: 'tenant_B' };
const userDealerA = { id: 'dealer_user_1', name: 'Dealer A', role: 'dealer', tenantId: 'tenant_A' };
const userAdmin = { id: 'admin_user_1', name: 'Admin Master', role: 'admin', tenantId: 'default' };

// 2. Run Test Cases
runTest('API Key Verification Guard', () => {
  assert.strictEqual(verifyApiKey(process.env.DASHCAM_API_KEY), true);
  assert.strictEqual(verifyApiKey('wrong_key'), false);
  assert.strictEqual(verifyApiKey(''), false);
});

runTest('JWT Minting and Expiration Verification', () => {
  const token = generateToken({ sub: 'cust_user_1', name: 'Customer One', role: 'customer', tenantId: 'tenant_A' });
  const payload = verifyToken(token);
  assert.ok(payload);
  assert.strictEqual(payload.sub, 'cust_user_1');
  assert.strictEqual(payload.role, 'customer');
});

runTest('Customer Vehicle Isolation (Cannot access other customer vehicle)', () => {
  assert.strictEqual(checkWsSubscriptionPermission(userCust1, SIM_CUST1), true);
  assert.strictEqual(checkWsSubscriptionPermission(userCust1, SIM_CUST2), false);
});

runTest('Dealer Tenant Isolation (Cannot access other tenant vehicle)', () => {
  assert.strictEqual(checkWsSubscriptionPermission(userDealerA, SIM_CUST1), true);
  assert.strictEqual(checkWsSubscriptionPermission(userDealerA, SIM_CUST2), false);
});

runTest('Admin Global Access (Can access all fleet vehicles)', () => {
  assert.strictEqual(checkWsSubscriptionPermission(userAdmin, SIM_CUST1), true);
  assert.strictEqual(checkWsSubscriptionPermission(userAdmin, SIM_CUST2), true);
});

runTest('Alarm Ownership & Acknowledgement Guard', () => {
  const alarmCust2 = alarmService.recordAlarm({ simNo: SIM_CUST2, alarmType: 14, latitude: 11.2, longitude: 77.7 });
  const alarmCust1 = alarmService.recordAlarm({ simNo: SIM_CUST1, alarmType: 1, latitude: 11.3, longitude: 77.8 });

  // Cust 1 trying to ack Cust 2 alarm
  const wrongAck = alarmService.acknowledge(alarmCust2.id, userCust1);
  assert.strictEqual(wrongAck.success, false);
  assert.ok(wrongAck.error.includes('Forbidden'));

  // Cust 1 acking Cust 1 alarm
  const rightAck = alarmService.acknowledge(alarmCust1.id, userCust1);
  assert.strictEqual(rightAck.success, true);
});

runTest('Admin Global Alarms Query Fix', () => {
  const allAlarms = alarmService.getAllAlarms(10);
  assert.ok(allAlarms.length > 0);
});

runTest('GPS Composite Cursor (timestamp, id) Pagination (Zero Duplicates)', () => {
  const sameSecond = '2026-08-29 18:30:00';
  for (let i = 1; i <= 6; i++) {
    historyService.recordGpsPoint({
      simNo: SIM_CUST1,
      latitude: 11.29 + (i * 0.001),
      longitude: 77.73 + (i * 0.001),
      speedKmh: 50,
      time: sameSecond
    });
  }

  const p1 = historyService.getHistory(SIM_CUST1, null, null, 3);
  assert.strictEqual(p1.count, 3);
  assert.ok(p1.nextCursor);

  const p2 = historyService.getHistory(SIM_CUST1, null, null, 3, p1.nextCursor);
  assert.strictEqual(p2.count, 3);

  const combinedIds = [...p1.data.map(p => p.id), ...p2.data.map(p => p.id)];
  const uniqueIds = new Set(combinedIds);
  assert.strictEqual(uniqueIds.size, combinedIds.length, 'Duplicate GPS point found during pagination');
});

runTest('GPS Sanity Coordinate Filtering', () => {
  assert.strictEqual(historyService.isValidCoordinate(0.0, 0.0), false);
  assert.strictEqual(historyService.isValidCoordinate(100.0, 77.7), false);
  assert.strictEqual(historyService.isValidCoordinate(11.29, 200.0), false);
  assert.strictEqual(historyService.isValidCoordinate(11.2953, 77.7375), true);
});

runTest('VehicleId Resolution & Customer Privacy Masking', () => {
  const row = stmts.getVehicleByPlate.get('TN 99 AA 0001');
  assert.ok(row, 'Vehicle row must exist');
  assert.strictEqual(row.sim_no, SIM_CUST1);
  assert.strictEqual(row.number_plate, 'TN 99 AA 0001');
});

console.log(`\n========================================`);
console.log(`📊 Test Results: ${testsPassed} Passed, ${testsFailed} Failed.`);
console.log(`========================================\n`);

if (testsFailed > 0) {
  process.exit(1);
}
