import app from '../src/app.js';
import http from 'http';

const PORT = 5002;
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
      console.log('--- STARTING ESP32 ACCESS CONTROL FLOW TESTS ---\n');

      const testSerial = `C9:D8:E7:${Math.floor(10 + Math.random() * 89)}`;

      // 1. GET /add-card when idle
      console.log('[1] Testing GET /add-card when idle...');
      const addCardIdle = await request('GET', '/add-card');
      console.log(`Status: ${addCardIdle.status}, Body:`, addCardIdle.body);
      if (addCardIdle.body.status !== 'idle') {
        throw new Error('Add-card idle test failed!');
      }

      // 2. POST /admin/start-enrollment
      console.log('\n[2] Testing POST /admin/start-enrollment (JSON)...');
      const startEnroll = await request('POST', '/admin/start-enrollment', { userName: 'Access User', fingerId: 12 });
      console.log(`Status: ${startEnroll.status}, Body:`, startEnroll.body);
      if (startEnroll.status !== 200 || startEnroll.body.targetFingerId !== 12) {
        throw new Error('Start enrollment test failed!');
      }

      // 3. GET /add-card when active (< 45s)
      console.log('\n[3] Testing GET /add-card within 45s timeout...');
      const addCardPending = await request('GET', '/add-card');
      console.log(`Status: ${addCardPending.status}, Body:`, addCardPending.body);
      if (addCardPending.body.status !== 'pending' || addCardPending.body.fingerId !== 12) {
        throw new Error('Add-card pending test failed!');
      }

      // 4. POST /save-card (form-urlencoded)
      console.log(`\n[4] Testing POST /save-card with uid=${testSerial}...`);
      const saveCardRes = await request('POST', '/save-card', { uid: testSerial }, true);
      console.log(`Status: ${saveCardRes.status}, Body:`, saveCardRes.body);
      if (saveCardRes.status !== 200 || saveCardRes.body.success !== true) {
        throw new Error('Save-card test failed!');
      }

      // 5. GET /add-card IMMEDIATELY after /save-card (must return idle immediately)
      console.log('\n[5] Testing GET /add-card IMMEDIATELY after /save-card (must revert to idle)...');
      const addCardAfterSave = await request('GET', '/add-card');
      console.log(`Status: ${addCardAfterSave.status}, Body:`, addCardAfterSave.body);
      if (addCardAfterSave.body.status !== 'idle') {
        throw new Error('Add-card after save test failed! Expected status idle.');
      }

      // 6. POST /verify matching registered card
      console.log(`\n[6] Testing POST /verify with registered uid=${testSerial}...`);
      const verifyRes = await request('POST', '/verify', { uid: testSerial }, true);
      console.log(`Status: ${verifyRes.status}, Body:`, verifyRes.body);
      if (verifyRes.body.status !== true) {
        throw new Error('Verify test failed! Expected status: true');
      }

      // 7. POST /complete-enrollment
      console.log('\n[7] Testing POST /complete-enrollment...');
      const completeRes = await request('POST', '/complete-enrollment', {
        userName: 'Complete User',
        rfid_uid: `F1:E2:D3:${Math.floor(10 + Math.random() * 89)}`,
        fingerprint_id: 15
      }, true);
      console.log(`Status: ${completeRes.status}, Body:`, completeRes.body);
      if (completeRes.body.success !== true) {
        throw new Error('Complete enrollment test failed!');
      }

      // 8. GET /add-card after complete-enrollment (must return idle)
      console.log('\n[8] Testing GET /add-card after complete-enrollment (must be idle)...');
      const addCardAfterComplete = await request('GET', '/add-card');
      console.log(`Status: ${addCardAfterComplete.status}, Body:`, addCardAfterComplete.body);
      if (addCardAfterComplete.body.status !== 'idle') {
        throw new Error('Add-card after complete test failed!');
      }

      console.log('\n--- ALL ESP32 ACCESS CONTROL FLOW TESTS PASSED SUCCESSFULLY ---');
    } catch (err) {
      console.error('\nTEST FAILURE:', err);
      process.exitCode = 1;
    } finally {
      server.close();
    }
  });
}

runTests();
