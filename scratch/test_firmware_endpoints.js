import app from '../src/app.js';
import http from 'http';

const PORT = 5001;
const server = http.createServer(app);

function request(method, path, body = null, isUrlEncoded = false) {
  return new Promise((resolve, reject) => {
    const headers = {};
    let dataStr = null;

    if (body) {
      if (isUrlEncoded) {
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
        dataStr = new URLSearchParams(body).toString();
      } else {
        headers['Content-Type'] = 'application/json';
        dataStr = JSON.stringify(body);
      }
      headers['Content-Length'] = Buffer.byteLength(dataStr);
    }

    const req = http.request(
      {
        host: 'localhost',
        port: PORT,
        method,
        path,
        headers,
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => (raw += chunk));
        res.on('end', () => {
          let parsed = raw;
          try {
            parsed = JSON.parse(raw);
          } catch (e) {}
          resolve({ status: res.statusCode, body: parsed, raw });
        });
      }
    );

    req.on('error', reject);
    if (dataStr) req.write(dataStr);
    req.end();
  });
}

async function runTests() {
  server.listen(PORT, async () => {
    console.log(`Test server running on port ${PORT}\n`);
    try {
      console.log('--- STARTING FIRMWARE & ADMIN ENDPOINT TESTS ---\n');

      const testSerial = `A1:B2:C3:${Math.floor(10 + Math.random() * 89)}`;

      // 1. POST /verify with valid active RFID UID
      console.log('[1] Testing POST /verify (form-urlencoded) with valid active UID (SN-ALICE-101)...');
      const verifySuccess = await request('POST', '/verify', { uid: 'SN-ALICE-101' }, true);
      console.log(`Status: ${verifySuccess.status}, Body:`, verifySuccess.body);
      if (verifySuccess.status !== 200 || verifySuccess.body.status !== true) {
        throw new Error('Verification test 1 failed!');
      }

      // 2. POST /verify with unknown UID
      console.log('\n[2] Testing POST /verify with unknown UID...');
      const verifyFail = await request('POST', '/verify', { uid: 'UNKNOWN_99999' }, true);
      console.log(`Status: ${verifyFail.status}, Body:`, verifyFail.body);
      if (verifyFail.status !== 200 || verifyFail.body.status !== false) {
        throw new Error('Verification test 2 failed!');
      }

      // 3. GET /add-card when idle
      console.log('\n[3] Testing GET /add-card when idle...');
      const addCardIdle = await request('GET', '/add-card');
      console.log(`Status: ${addCardIdle.status}, Body:`, addCardIdle.body);
      if (addCardIdle.body.status !== 'idle') {
        throw new Error('Add-card idle test failed!');
      }

      // 4. POST /api/admin/enroll (JSON)
      console.log('\n[4] Testing POST /api/admin/enroll (JSON)...');
      const adminEnroll = await request('POST', '/api/admin/enroll', { fingerId: 7, userName: 'Firmware Test User' });
      console.log(`Status: ${adminEnroll.status}, Body:`, adminEnroll.body);
      if (adminEnroll.status !== 200 || adminEnroll.body.status !== 'success') {
        throw new Error('Admin enroll test failed!');
      }

      // 5. GET /add-card when pending
      console.log('\n[5] Testing GET /add-card when pending enrollment session exists...');
      const addCardPending = await request('GET', '/add-card');
      console.log(`Status: ${addCardPending.status}, Body:`, addCardPending.body);
      if (addCardPending.body.status !== 'pending' || addCardPending.body.fingerId !== 7) {
        throw new Error('Add-card pending test failed!');
      }

      // 6. POST /save-card (form-urlencoded)
      console.log(`\n[6] Testing POST /save-card (form-urlencoded) with uid=${testSerial}...`);
      const saveCardRes = await request('POST', '/save-card', { uid: testSerial }, true);
      console.log(`Status: ${saveCardRes.status}, Body:`, saveCardRes.body);
      if (saveCardRes.status !== 200 || saveCardRes.body.success !== true) {
        throw new Error('Save-card test failed!');
      }

      // 7. GET /add-card after saving (should return idle)
      console.log('\n[7] Testing GET /add-card after save-card (should be idle)...');
      const addCardAfterSave = await request('GET', '/add-card');
      console.log(`Status: ${addCardAfterSave.status}, Body:`, addCardAfterSave.body);
      if (addCardAfterSave.body.status !== 'idle') {
        throw new Error('Add-card after save test failed!');
      }

      // 8. POST /verify with newly saved RFID UID
      console.log(`\n[8] Testing POST /verify with newly saved RFID UID ${testSerial}...`);
      const verifyNew = await request('POST', '/verify', { uid: testSerial }, true);
      console.log(`Status: ${verifyNew.status}, Body:`, verifyNew.body);
      if (verifyNew.body.status !== true) {
        throw new Error('Verify new card failed!');
      }

      // 9. GET /api/admin/users
      console.log('\n[9] Testing GET /api/admin/users...');
      const adminUsers = await request('GET', '/api/admin/users');
      console.log(`Status: ${adminUsers.status}, Total users: ${adminUsers.body.total}`);
      if (adminUsers.status !== 200 || !Array.isArray(adminUsers.body.users)) {
        throw new Error('Admin users list test failed!');
      }

      // 10. DELETE /api/admin/users/:id
      const targetUser = adminUsers.body.users.find((u) => u.rfidUid === testSerial);
      console.log(`\n[10] Testing DELETE /api/admin/users/${targetUser.id}...`);
      const deleteUserRes = await request('DELETE', `/api/admin/users/${targetUser.id}`);
      console.log(`Status: ${deleteUserRes.status}, Body:`, deleteUserRes.body);
      if (deleteUserRes.status !== 200 || deleteUserRes.body.status !== 'success') {
        throw new Error('Delete user test failed!');
      }

      console.log('\n--- ALL FIRMWARE & ADMIN ENDPOINT TESTS PASSED SUCCESSFULLY ---');
    } catch (err) {
      console.error('\nTEST FAILURE:', err);
      process.exitCode = 1;
    } finally {
      server.close();
    }
  });
}

runTests();
