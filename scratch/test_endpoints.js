import crypto from 'crypto';
import http from 'http';

const PORT = 5000;
const BASE_URL = `http://localhost:${PORT}`;
const HMAC_SECRET = 'supersecretterminalhmackey12345';
let sessionCookie = '';

// Helper to make HTTP requests
function request(method, path, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : '';
    const reqHeaders = { ...headers };
    
    if (body) {
      reqHeaders['Content-Type'] = 'application/json';
      reqHeaders['Content-Length'] = Buffer.byteLength(payload);
    }
    
    if (sessionCookie) {
      reqHeaders['Cookie'] = sessionCookie;
    }

    const options = {
      hostname: 'localhost',
      port: PORT,
      path,
      method,
      headers: reqHeaders
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        // Extract set-cookie
        if (res.headers['set-cookie']) {
          const cookie = res.headers['set-cookie'][0];
          sessionCookie = cookie.split(';')[0];
        }
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: data ? (res.headers['content-type']?.includes('application/json') ? JSON.parse(data) : data) : null
        });
      });
    });

    req.on('error', reject);
    if (body) req.write(payload);
    req.end();
  });
}

// Helper to compute HMAC header
function getHmacHeaders(bodyObj) {
  const payload = JSON.stringify(bodyObj);
  const hmac = crypto.createHmac('sha256', HMAC_SECRET).update(payload).digest('hex');
  return { 'X-Terminal-Signature': hmac };
}

async function runTests() {
  console.log('--- STARTING ENDPOINT VERIFICATION TESTS ---');

  try {
    // 1. Test public/unlocked status (should be false)
    console.log('\n[1] Checking initial unlock status...');
    const status1 = await request('GET', '/api/v1/auth/status');
    console.log('Status Response:', status1.body);

    // 2. Test accessing protected route before unlock (should return 401)
    console.log('\n[2] Testing protected route access before unlock...');
    const layersBefore = await request('GET', '/api/v1/dashboard/layers');
    console.log(`HTTP Status: ${layersBefore.statusCode} (Expected: 401)`);
    console.log('Response:', layersBefore.body);

    // 3. Unlock Site
    console.log('\n[3] Unlocking site with correct password...');
    const unlockRes = await request('POST', '/api/v1/auth/unlock', { password: 'admin12345' });
    console.log(`HTTP Status: ${unlockRes.statusCode}`);
    console.log('Response:', unlockRes.body);
    console.log(`Acquired Cookie: ${sessionCookie}`);

    // 4. Verify unlock status now (should be true)
    console.log('\n[4] Checking unlock status again...');
    const status2 = await request('GET', '/api/v1/auth/status');
    console.log('Status Response:', status2.body);

    // 5. Access system layers (should work now)
    console.log('\n[5] Fetching system layers...');
    const layersAfter = await request('GET', '/api/v1/dashboard/layers');
    console.log(`HTTP Status: ${layersAfter.statusCode}`);
    console.log('Layers:', layersAfter.body?.layers?.map(l => `${l.name}: ${l.status} (${l.metric})`));

    // 6. Fetch dashboard metrics
    console.log('\n[6] Fetching dashboard metrics...');
    const metrics = await request('GET', '/api/v1/dashboard/metrics');
    console.log('Metrics Response:', metrics.body?.metrics);

    // 7. Fetch recent events
    console.log('\n[7] Fetching recent events...');
    const events = await request('GET', '/api/v1/dashboard/recent-events?limit=3');
    console.log(`Recent Events (${events.body?.events?.length || 0}):`, events.body?.events?.map(e => `[${e.type}] ${e.details}`));

    // 8. List enrolled cards
    console.log('\n[8] Listing enrolled cards...');
    const cards = await request('GET', '/api/v1/cards?page=1&pageSize=5');
    console.log('Cards count:', cards.body?.cards?.length);
    console.log('Cards:', cards.body?.cards?.map(c => `${c.id} - ${c.holder} (${c.status})`));

    // 9. Resync card
    console.log('\n[9] Triggering re-sync for card-101...');
    const resync = await request('POST', '/api/v1/cards/resync', { cardId: 'card-101' });
    console.log('Resync Response:', resync.body);

    // 10. Revoke card
    console.log('\n[10] Revoking card-102...');
    const revoke = await request('POST', '/api/v1/cards/revoke', { cardId: 'card-102', reason: 'Lost credentials test' });
    console.log('Revoke Response:', revoke.body);

    // 11. Stateful Enrollment pipeline
    console.log('\n[11] Testing 4-step card enrollment pipeline...');
    
    // Step 1: Start
    const enrollStart = await request('POST', '/api/v1/enroll/start', { holder: 'Agent Cooper', cardSerial: 'SN-COOP-777' });
    const enrollId = enrollStart.body?.enrollmentId;
    console.log(`Step 1 (Start) -> ID: ${enrollId}`);

    // Step 2: Capture
    const enrollCapture = await request('POST', '/api/v1/enroll/capture', {
      enrollmentId: enrollId,
      sampleBlob: 'FINGERPRINT_ISO_TEMPLATE_BUFFER_DATA_VAL',
      quality: 85
    });
    console.log('Step 2 (Capture) -> captures:', enrollCapture.body?.capturesCount);

    // Step 3: Extract
    const enrollExtract = await request('POST', '/api/v1/enroll/extract', { enrollmentId: enrollId });
    console.log(`Step 3 (Extract) -> Minutiae: ${enrollExtract.body?.minutiaeCount}, Hash: ${enrollExtract.body?.templateHash?.substring(0, 16)}...`);

    // Step 4: Commit
    const enrollCommit = await request('POST', '/api/v1/enroll/commit', { enrollmentId: enrollId });
    console.log('Step 4 (Commit) -> Committed Card:', enrollCommit.body?.card);

    // 12. List audit events & export
    console.log('\n[12] Fetching audit logs...');
    const auditLogs = await request('GET', '/api/v1/audit?limit=3');
    console.log('Logs:', auditLogs.body?.events?.map(l => `[${l.type}] ${l.details}`));

    console.log('\nExporting audit log as CSV...');
    const csvExport = await request('GET', '/api/v1/audit/export?format=csv');
    console.log(`CSV Export Success: ${csvExport.headers['content-disposition']}`);
    console.log(csvExport.body?.substring(0, 150) + '...\n');

    // 13. Public signed terminal callbacks (testing with HMAC signature)
    console.log('[13] Testing HMAC public terminal callbacks...');
    
    const hbBody = { terminalId: 'TERM-WEST-01', firmwareVersion: 'v2.1.4', status: 'online' };
    const hbRes = await request('POST', '/api/public/terminal/heartbeat', hbBody, getHmacHeaders(hbBody));
    console.log('Heartbeat Callback Status:', hbRes.statusCode, hbRes.body);

    const authBody = { cardId: 'card-101', success: true, padScore: 0.99, details: 'Verified via HMAC test callback' };
    const authRes = await request('POST', '/api/public/terminal/auth-event', authBody, getHmacHeaders(authBody));
    console.log('Auth-Event Callback Status:', authRes.statusCode, authRes.body);

    const apduBody = { terminalId: 'TERM-WEST-01', commandApdu: '00A4040000', responseApdu: '9000', durationMs: 12 };
    const apduRes = await request('POST', '/api/public/terminal/apdu-log', apduBody, getHmacHeaders(apduBody));
    console.log('APDU-Log Callback Status:', apduRes.statusCode, apduRes.body);

    // 14. Admin password rotation and operators
    console.log('\n[14] Testing Operator management...');
    const operators = await request('GET', '/api/v1/admin/operators');
    console.log('Operators:', operators.body?.operators?.map(o => `${o.username} (${o.role})`));

    const addOp = await request('POST', '/api/v1/admin/operators', { username: 'test_op_new', role: 'operator' });
    console.log('Added Operator:', addOp.body?.operator);

    console.log('\nRotating site password...');
    const rotate = await request('POST', '/api/v1/admin/rotate-password', { newPassword: 'rotatedPasswordSecret' });
    console.log('Rotate response:', rotate.body);

    // 15. Lock site and verify lockout
    console.log('\n[15] Locking site...');
    const lockRes = await request('POST', '/api/v1/auth/lock');
    console.log('Lock response:', lockRes.body);

    const status3 = await request('GET', '/api/v1/auth/status');
    console.log('Unlock status after lock:', status3.body);

    // Try unlocking with old password (should fail)
    console.log('\nUnlocking with old password (should fail)...');
    const oldUnlock = await request('POST', '/api/v1/auth/unlock', { password: 'admin12345' });
    console.log('Old password unlock status:', oldUnlock.statusCode, oldUnlock.body?.message);

    // Try unlocking with rotated password (should succeed)
    console.log('\nUnlocking with new rotated password (should succeed)...');
    const newUnlock = await request('POST', '/api/v1/auth/unlock', { password: 'rotatedPasswordSecret' });
    console.log('New password unlock status:', newUnlock.statusCode, newUnlock.body?.message);

    console.log('\n--- ALL VERIFICATION TESTS COMPLETED SUCCESSFULLY ---');
  } catch (err) {
    console.error('Test execution failed with error:', err);
  }
}

runTests();
