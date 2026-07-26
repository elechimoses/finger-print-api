import app from '../src/app.js';
import http from 'http';

const PORT = 5003;
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
      console.log('--- TESTING DUPLICATE CARD PREVENTION ---\n');

      const dupSerial = `DUP-SERIAL-${Math.floor(1000 + Math.random() * 9000)}`;

      // 1. Start enrollment session 1
      console.log('[1] Starting enrollment session for First User...');
      const session1 = await request('POST', '/admin/start-enrollment', { userName: 'First User', fingerId: 21 });
      console.log(`Status: ${session1.status}`);

      // 2. Save card for session 1
      console.log(`[2] Saving card with serial ${dupSerial}...`);
      const save1 = await request('POST', '/save-card', { uid: dupSerial }, true);
      console.log(`Status: ${save1.status}, Body:`, save1.body);
      if (save1.status !== 200 || save1.body.success !== true) {
        throw new Error('First card save failed!');
      }

      // 3. Start enrollment session 2
      console.log('\n[3] Starting enrollment session for Second User...');
      const session2 = await request('POST', '/admin/start-enrollment', { userName: 'Second User', fingerId: 22 });
      console.log(`Status: ${session2.status}`);

      // 4. Attempt to save the SAME duplicate card for session 2
      console.log(`[4] Attempting to save DUPLICATE card with serial ${dupSerial}...`);
      const save2 = await request('POST', '/save-card', { uid: dupSerial }, true);
      console.log(`Status: ${save2.status}, Body:`, save2.body);

      if (save2.status !== 400 || save2.body.success !== false) {
        throw new Error('Duplicate card was NOT rejected with HTTP 400!');
      }

      if (!save2.body.message?.includes('already been enrolled')) {
        throw new Error('Duplicate error message missing expected text!');
      }

      // 5. Verify enrollment session was terminated (reverted to idle)
      console.log('\n[5] Verifying enrollment session was terminated (GET /add-card)...');
      const addCardState = await request('GET', '/add-card');
      console.log(`Status: ${addCardState.status}, Body:`, addCardState.body);
      if (addCardState.body.status !== 'idle') {
        throw new Error('Session was NOT terminated! Expected status idle.');
      }

      console.log('\n--- DUPLICATE CARD PREVENTION TEST PASSED SUCCESSFULLY ---');
    } catch (err) {
      console.error('\nTEST FAILURE:', err);
      process.exitCode = 1;
    } finally {
      server.close();
    }
  });
}

runTests();
