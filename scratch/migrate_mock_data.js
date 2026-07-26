import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const state = {
  sitePassword: 'admin12345',
  operators: [
    {
      id: 'op-1',
      username: 'admin',
      role: 'administrator',
      createdAt: new Date().toISOString()
    },
    {
      id: 'op-2',
      username: 'operator_dan',
      role: 'operator',
      createdAt: new Date().toISOString()
    }
  ],
  systemLayers: [
    {
      name: 'Physical',
      status: 'ok',
      metric: 'FW: v2.1.4 - Active',
      description: 'Smartcard reader terminal status'
    },
    {
      name: 'SE',
      status: 'ok',
      metric: 'Initialized',
      description: 'Secure Element applet verification status'
    },
    {
      name: 'MoC',
      status: 'ok',
      metric: 'ISO Matcher Active',
      description: 'Match-on-Card execution engine status'
    },
    {
      name: 'Storage',
      status: 'ok',
      metric: '92% Free',
      description: 'Secure storage & database connection'
    },
    {
      name: 'App',
      status: 'ok',
      metric: 'API online',
      description: 'Express backend service health'
    }
  ],
  cards: [
    {
      id: 'card-101',
      holder: 'Alice Smith',
      serial: 'SN-ALICE-101',
      templateFormat: 'ISO 19794-2',
      minutiaeCount: 38,
      syncStatus: 'synced',
      status: 'active',
      lastSeen: new Date().toISOString(),
      revocationReason: null
    },
    {
      id: 'card-102',
      holder: 'Bob Jones',
      serial: 'SN-BOB-102',
      templateFormat: 'ISO 19794-2',
      minutiaeCount: 42,
      syncStatus: 'synced',
      status: 'active',
      lastSeen: new Date().toISOString(),
      revocationReason: null
    }
  ],
  auditLogs: [
    {
      id: 'evt-1',
      timestamp: new Date().toISOString(),
      type: 'admin',
      cardId: null,
      holder: null,
      details: 'System database initialized with mock records.',
      rawMetrics: {},
      receipt: { action: 'SEED' },
      minutiaeMapPoints: [],
      padScore: 1.0
    },
    {
      id: 'evt-2',
      timestamp: new Date().toISOString(),
      type: 'auth_success',
      cardId: 'card-101',
      holder: 'Alice Smith',
      details: 'Verified holder: Alice Smith via secure Match-on-Card.',
      rawMetrics: { matchScore: 88, padScore: 0.98 },
      receipt: { verificationMode: 'biometric' },
      minutiaeMapPoints: [],
      padScore: 0.98
    }
  ]
};


const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://megxtwqfhyklkfpyrety.supabase.co';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || 'sb_publishable_JPrI8PGFgT_YmVl7wEPzjg_zQgPO5RU';
const dbUrl = process.env.DATABASE_URL;

const supabase = createClient(supabaseUrl, supabaseKey);


async function migrateWithPg() {
  console.log('Starting direct PostgreSQL migration (bypassing RLS)...');
  const pg = await import('pg');
  const client = new pg.default.Client({
    connectionString: dbUrl,
    ssl: { rejectUnauthorized: false }
  });
  await client.connect();

  try {
    // 1. Settings
    console.log('Migrating settings (site password)...');
    await client.query(
      `INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      ['site_password', state.sitePassword]
    );
    console.log('Settings migrated successfully.');

    // 2. Operators
    console.log('Migrating operators...');
    for (const op of state.operators) {
      await client.query(
        `INSERT INTO operators (id, username, role, created_at) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO UPDATE SET username = EXCLUDED.username, role = EXCLUDED.role, created_at = EXCLUDED.created_at`,
        [op.id, op.username, op.role, op.createdAt]
      );
    }
    console.log('Operators migrated successfully.');

    // 3. System Layers
    console.log('Migrating system layers...');
    for (const l of state.systemLayers) {
      await client.query(
        `INSERT INTO system_layers (name, status, metric, description) VALUES ($1, $2, $3, $4) ON CONFLICT (name) DO UPDATE SET status = EXCLUDED.status, metric = EXCLUDED.metric, description = EXCLUDED.description`,
        [l.name, l.status, l.metric, l.description]
      );
    }
    console.log('System layers migrated successfully.');

    // 4. Cards
    console.log('Migrating cards...');
    for (const c of state.cards) {
      await client.query(
        `INSERT INTO cards (id, holder, serial, template_format, minutiae_count, sync_status, status, last_seen, revocation_reason) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (id) DO UPDATE SET holder = EXCLUDED.holder, serial = EXCLUDED.serial, template_format = EXCLUDED.template_format, minutiae_count = EXCLUDED.minutiae_count, sync_status = EXCLUDED.sync_status, status = EXCLUDED.status, last_seen = EXCLUDED.last_seen, revocation_reason = EXCLUDED.revocation_reason`,
        [c.id, c.holder, c.serial, c.templateFormat, c.minutiaeCount, c.syncStatus, c.status, c.lastSeen, c.revocationReason]
      );
    }
    console.log('Cards migrated successfully.');

    // 5. Audit Logs
    console.log('Migrating audit logs...');
    for (const log of state.auditLogs) {
      await client.query(
        `INSERT INTO audit_logs (id, timestamp, type, card_id, holder, details, raw_metrics, receipt, minutiae_map_points, pad_score) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (id) DO UPDATE SET timestamp = EXCLUDED.timestamp, type = EXCLUDED.type, card_id = EXCLUDED.card_id, holder = EXCLUDED.holder, details = EXCLUDED.details, raw_metrics = EXCLUDED.raw_metrics, receipt = EXCLUDED.receipt, minutiae_map_points = EXCLUDED.minutiae_map_points, pad_score = EXCLUDED.pad_score`,
        [log.id, log.timestamp, log.type, log.cardId, log.holder, log.details, JSON.stringify(log.rawMetrics), JSON.stringify(log.receipt), JSON.stringify(log.minutiaeMapPoints), log.padScore]
      );
    }
    console.log('Audit logs migrated successfully.');

    console.log('PostgreSQL migration finished!');
  } finally {
    await client.end();
  }
}

async function migrate() {
  const useDirectPg = dbUrl && !dbUrl.includes('[YOUR-PASSWORD]');
  if (useDirectPg) {
    try {
      await migrateWithPg();
      return;
    } catch (err) {
      console.error('Direct PostgreSQL migration failed:', err);
      console.log('Falling back to Supabase HTTP API client...');
    }
  }

  console.log('Starting mock data migration via Supabase REST API...');
  console.log('URL:', supabaseUrl);

  // 1. Settings
  console.log('Migrating settings (site password)...');
  const { error: settingsError } = await supabase
    .from('settings')
    .upsert([{ key: 'site_password', value: state.sitePassword }]);
  
  if (settingsError) {
    console.error('Error migrating settings:', settingsError);
  } else {
    console.log('Settings migrated successfully.');
  }

  // 2. Operators
  console.log('Migrating operators...');
  const operatorsData = state.operators.map(op => ({
    id: op.id,
    username: op.username,
    role: op.role,
    created_at: op.createdAt
  }));
  const { error: opError } = await supabase
    .from('operators')
    .upsert(operatorsData);
  
  if (opError) {
    console.error('Error migrating operators:', opError);
  } else {
    console.log('Operators migrated successfully.');
  }

  // 3. System Layers
  console.log('Migrating system layers...');
  const layersData = state.systemLayers.map(l => ({
    name: l.name,
    status: l.status,
    metric: l.metric,
    description: l.description
  }));
  const { error: layerError } = await supabase
    .from('system_layers')
    .upsert(layersData);
  
  if (layerError) {
    console.error('Error migrating system layers:', layerError);
  } else {
    console.log('System layers migrated successfully.');
  }

  // 4. Cards
  console.log('Migrating cards...');
  const cardsData = state.cards.map(c => ({
    id: c.id,
    holder: c.holder,
    serial: c.serial,
    template_format: c.templateFormat,
    minutiae_count: c.minutiaeCount,
    sync_status: c.syncStatus,
    status: c.status,
    last_seen: c.lastSeen,
    revocation_reason: c.revocationReason || null
  }));
  const { error: cardError } = await supabase
    .from('cards')
    .upsert(cardsData);
  
  if (cardError) {
    console.error('Error migrating cards:', cardError);
  } else {
    console.log('Cards migrated successfully.');
  }

  // 5. Audit Logs
  console.log('Migrating audit logs...');
  const logsData = state.auditLogs.map(log => ({
    id: log.id,
    timestamp: log.timestamp,
    type: log.type,
    card_id: log.cardId,
    holder: log.holder,
    details: log.details,
    raw_metrics: log.rawMetrics,
    receipt: log.receipt,
    minutiae_map_points: log.minutiaeMapPoints,
    pad_score: log.padScore
  }));
  const { error: logError } = await supabase
    .from('audit_logs')
    .upsert(logsData);
  
  if (logError) {
    console.error('Error migrating audit logs:', logError);
  } else {
    console.log('Audit logs migrated successfully.');
  }

  console.log('Mock data migration finished!');
}

migrate();

