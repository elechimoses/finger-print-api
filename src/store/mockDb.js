import { EventEmitter } from 'events';
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import dotenv from 'dotenv';

// Load environmental variables, supporting .env and .env.local
dotenv.config();
dotenv.config({ path: '.env.local' });

// Create a singleton Event Emitter to bridge incoming public APDU logs to the SSE stream endpoint
export const apduEventEmitter = new EventEmitter();

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

const supabase = (supabaseUrl && supabaseKey) ? createClient(supabaseUrl, supabaseKey) : null;

// --- In-Memory Fallback State (for offline/network isolated mode) ---
const inMemory = {
  sitePassword: process.env.SITE_PASSWORD || 'admin12345',
  sessions: new Map(), // token -> expiresAt
  operators: [
    { id: 'op-1', username: 'admin', role: 'administrator', createdAt: new Date().toISOString() },
    { id: 'op-2', username: 'operator_dan', role: 'operator', createdAt: new Date().toISOString() }
  ],
  systemLayers: [
    { name: 'Physical', status: 'ok', metric: 'FW: v2.1.4 - Active', description: 'Smartcard reader terminal status' },
    { name: 'SE', status: 'ok', metric: 'Initialized', description: 'Secure Element applet verification status' },
    { name: 'MoC', status: 'ok', metric: 'ISO Matcher Active', description: 'Match-on-Card execution engine status' },
    { name: 'Storage', status: 'ok', metric: '92% Free', description: 'Secure storage & database connection' },
    { name: 'App', status: 'ok', metric: 'API online', description: 'Express backend service health' }
  ],
  cards: [
    { id: 'card-101', holder: 'Alice Smith', serial: 'SN-ALICE-101', templateFormat: 'ISO 19794-2', minutiaeCount: 38, syncStatus: 'synced', status: 'active', lastSeen: new Date().toISOString(), revocationReason: null },
    { id: 'card-102', holder: 'Bob Jones', serial: 'SN-BOB-102', templateFormat: 'ISO 19794-2', minutiaeCount: 42, syncStatus: 'synced', status: 'active', lastSeen: new Date().toISOString(), revocationReason: null }
  ],
  auditLogs: [
    { id: 'evt-1', timestamp: new Date().toISOString(), type: 'admin', cardId: null, holder: null, details: 'System database initialized with mock records.', rawMetrics: {}, receipt: { action: 'SEED' }, minutiaeMapPoints: [], padScore: 1.0 },
    { id: 'evt-2', timestamp: new Date().toISOString(), type: 'auth_success', cardId: 'card-101', holder: 'Alice Smith', details: 'Verified holder: Alice Smith via secure Match-on-Card.', rawMetrics: { matchScore: 88, padScore: 0.98 }, receipt: { verificationMode: 'biometric' }, minutiaeMapPoints: [], padScore: 0.98 }
  ],
  enrollmentSessions: new Map()
};

// --- Mappings between Database (snake_case) and App models (camelCase) ---

function mapOperatorFromDb(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    createdAt: row.created_at
  };
}

function mapOperatorToDb(model) {
  if (!model) return null;
  return {
    id: model.id,
    username: model.username,
    role: model.role,
    created_at: model.createdAt
  };
}

function mapCardFromDb(row) {
  if (!row) return null;
  return {
    id: row.id,
    holder: row.holder,
    serial: row.serial,
    templateFormat: row.template_format,
    minutiaeCount: row.minutiae_count,
    fingerId: row.finger_id ?? row.id,
    syncStatus: row.sync_status,
    status: row.status,
    lastSeen: row.last_seen,
    revocationReason: row.revocation_reason
  };
}

function mapCardToDb(model) {
  if (!model) return null;
  return {
    id: model.id,
    holder: model.holder,
    serial: model.serial,
    template_format: model.templateFormat,
    minutiae_count: model.minutiaeCount,
    sync_status: model.syncStatus,
    status: model.status,
    last_seen: model.lastSeen,
    revocation_reason: model.revocationReason
  };
}

function mapAuditLogFromDb(row) {
  if (!row) return null;
  return {
    id: row.id,
    timestamp: row.timestamp,
    type: row.type,
    cardId: row.card_id,
    holder: row.holder,
    details: row.details,
    rawMetrics: row.raw_metrics,
    receipt: row.receipt,
    minutiaeMapPoints: row.minutiae_map_points,
    padScore: row.pad_score ? parseFloat(row.pad_score) : 0
  };
}

function mapAuditLogToDb(model) {
  if (!model) return null;
  return {
    id: model.id,
    timestamp: model.timestamp,
    type: model.type,
    card_id: model.cardId,
    holder: model.holder,
    details: model.details,
    raw_metrics: model.rawMetrics,
    receipt: model.receipt,
    minutiae_map_points: model.minutiaeMapPoints,
    pad_score: model.padScore
  };
}

function mapEnrollmentSessionFromDb(row) {
  if (!row) return null;
  return {
    id: row.id,
    holder: row.holder,
    cardSerial: row.card_serial,
    step: row.step,
    captures: row.captures || [],
    minutiaeCount: row.minutiae_count,
    templateHash: row.template_hash,
    status: row.status,
    createdAt: row.created_at
  };
}

function mapEnrollmentSessionToDb(model) {
  if (!model) return null;
  return {
    id: model.id,
    holder: model.holder,
    card_serial: model.cardSerial,
    step: model.step,
    captures: model.captures,
    minutiae_count: model.minutiaeCount,
    template_hash: model.templateHash,
    status: model.status,
    created_at: model.createdAt
  };
}

// --- Asynchronous Database Access Methods ---

export const db = {
  // 1. Settings / Password management
  async getSitePassword() {
    try {
      if (supabase) {
        const { data, error } = await supabase.from('settings').select('value').eq('key', 'site_password').single();
        if (!error && data) return data.value;
      }
    } catch (e) {}
    return inMemory.sitePassword;
  },

  async rotatePassword(newPassword) {
    inMemory.sitePassword = newPassword;
    try {
      if (supabase) {
        await supabase.from('settings').upsert({ key: 'site_password', value: newPassword });
      }
    } catch (e) {}
  },

  // 2. Unlocked Sessions
  async getSession(token) {
    try {
      if (supabase) {
        const { data, error } = await supabase.from('unlocked_sessions').select('*').eq('token', token).single();
        if (!error && data) return { token: data.token, expiresAt: data.expires_at };
      }
    } catch (e) {}
    const expiresAt = inMemory.sessions.get(token);
    if (!expiresAt) return null;
    return { token, expiresAt };
  },

  async setSession(token, expiresAt) {
    inMemory.sessions.set(token, expiresAt);
    try {
      if (supabase) {
        await supabase.from('unlocked_sessions').upsert({ token, expires_at: expiresAt });
      }
    } catch (e) {}
  },

  async deleteSession(token) {
    inMemory.sessions.delete(token);
    try {
      if (supabase) {
        await supabase.from('unlocked_sessions').delete().eq('token', token);
      }
    } catch (e) {}
  },

  // 3. Operators
  async getOperators() {
    try {
      if (supabase) {
        const { data, error } = await supabase.from('operators').select('*').order('created_at', { ascending: true });
        if (!error && data) return data.map(mapOperatorFromDb);
      }
    } catch (e) {}
    return inMemory.operators;
  },

  async getOperatorByUsername(username) {
    try {
      if (supabase) {
        const { data, error } = await supabase.from('operators').select('*').ilike('username', username);
        if (!error && data && data.length > 0) return mapOperatorFromDb(data[0]);
      }
    } catch (e) {}
    return inMemory.operators.find(op => op.username.toLowerCase() === username.toLowerCase()) || null;
  },

  async addOperator(operator) {
    inMemory.operators.push(operator);
    try {
      if (supabase) {
        await supabase.from('operators').insert(mapOperatorToDb(operator));
      }
    } catch (e) {}
  },

  async deleteOperator(operatorId) {
    inMemory.operators = inMemory.operators.filter(op => op.id !== operatorId);
    try {
      if (supabase) {
        await supabase.from('operators').delete().eq('id', operatorId);
      }
    } catch (e) {}
  },

  // 4. System Layers (Dashboard status)
  async getSystemLayers() {
    try {
      if (supabase) {
        const { data, error } = await supabase.from('system_layers').select('*');
        if (!error && data) return data;
      }
    } catch (e) {}
    return inMemory.systemLayers;
  },

  async updateSystemLayer(name, status, metric) {
    const layer = inMemory.systemLayers.find(l => l.name === name);
    if (layer) {
      layer.status = status;
      layer.metric = metric;
    }
    try {
      if (supabase) {
        await supabase.from('system_layers').update({ status, metric }).eq('name', name);
      }
    } catch (e) {}
  },

  // 5. Cards (Enrolled Cards)
  async getCards(options = {}) {
    const { q, syncStatus, page = 1, pageSize = 10 } = options;
    try {
      if (supabase) {
        let query = supabase.from('cards').select('*', { count: 'exact' });
        if (syncStatus) query = query.eq('sync_status', syncStatus);
        if (q) query = query.or(`holder.ilike.%${q}%,serial.ilike.%${q}%`);
        const startIndex = (parseInt(page, 10) - 1) * parseInt(pageSize, 10);
        const endIndex = startIndex + parseInt(pageSize, 10) - 1;
        query = query.order('id', { ascending: true }).range(startIndex, endIndex);
        const { data, count, error } = await query;
        if (!error && data) {
          return { cards: data.map(mapCardFromDb), total: count };
        }
      }
    } catch (e) {}

    // Fallback to in-memory store ONLY if Supabase is offline/unavailable
    let list = [...inMemory.cards];
    if (syncStatus) list = list.filter(c => c.syncStatus === syncStatus);
    if (q) {
      const queryLower = q.toLowerCase();
      list = list.filter(c => c.holder.toLowerCase().includes(queryLower) || c.serial.toLowerCase().includes(queryLower));
    }
    const total = list.length;
    const startIndex = (parseInt(page, 10) - 1) * parseInt(pageSize, 10);
    const paginated = list.slice(startIndex, startIndex + parseInt(pageSize, 10));
    return { cards: paginated, total };
  },

  async getCardById(cardId) {
    try {
      if (supabase) {
        const { data, error } = await supabase.from('cards').select('*').eq('id', cardId).maybeSingle();
        if (!error && data) return mapCardFromDb(data);
      }
    } catch (e) {}
    return inMemory.cards.find(c => c.id === cardId) || null;
  },

  async getCardBySerial(serial) {
    try {
      if (supabase) {
        const { data, error } = await supabase.from('cards').select('*').eq('serial', serial).order('id', { ascending: false });
        if (!error && data && data.length > 0) {
          const activeCard = data.find(c => c.status === 'active');
          return mapCardFromDb(activeCard || data[0]);
        }
      }
    } catch (e) {}
    const activeMatch = inMemory.cards.find(c => (c.serial === serial || c.serial?.toLowerCase() === serial?.toLowerCase()) && c.status === 'active');
    if (activeMatch) return activeMatch;
    return inMemory.cards.find(c => c.serial === serial || c.serial?.toLowerCase() === serial?.toLowerCase()) || null;
  },

  async addCard(card) {
    try {
      if (supabase) {
        const { error } = await supabase.from('cards').insert(mapCardToDb(card));
        if (error) {
          if (error.code === '23505' || error.message?.includes('duplicate key')) {
            throw new Error(`This card (UID: ${card.serial}) has already been enrolled in the system.`);
          }
          console.error('[Supabase addCard error]:', error);
        }
      }
    } catch (e) {
      if (e.message?.includes('already been enrolled')) throw e;
      console.error('[Supabase addCard exception]:', e);
    }

    // Update in-memory fallback list
    if (!inMemory.cards.some(c => c.id === card.id || c.serial === card.serial)) {
      inMemory.cards.push(card);
    } else {
      const idx = inMemory.cards.findIndex(c => c.id === card.id || c.serial === card.serial);
      if (idx !== -1) inMemory.cards[idx] = card;
    }
  },

  async deleteCard(cardId) {
    inMemory.cards = inMemory.cards.filter(c => c.id !== cardId);
    try {
      if (supabase) {
        await supabase.from('cards').delete().eq('id', cardId);
      }
    } catch (e) {}
  },

  async updateCard(cardId, updates) {
    const card = inMemory.cards.find(c => c.id === cardId);
    if (card) {
      if (updates.status !== undefined) card.status = updates.status;
      if (updates.syncStatus !== undefined) card.syncStatus = updates.syncStatus;
      if (updates.lastSeen !== undefined) card.lastSeen = updates.lastSeen;
      if (updates.revocationReason !== undefined) card.revocationReason = updates.revocationReason;
    }
    try {
      if (supabase) {
        const dbUpdates = {};
        if (updates.status !== undefined) dbUpdates.status = updates.status;
        if (updates.syncStatus !== undefined) dbUpdates.sync_status = updates.syncStatus;
        if (updates.lastSeen !== undefined) dbUpdates.last_seen = updates.lastSeen;
        if (updates.revocationReason !== undefined) dbUpdates.revocation_reason = updates.revocationReason;
        await supabase.from('cards').update(dbUpdates).eq('id', cardId);
      }
    } catch (e) {}
  },

  // 6. Audit Logs
  async getAuditLogs(options = {}) {
    const { from, to, type, cardId, limit = 20, cursor } = options;
    try {
      if (supabase) {
        let query = supabase.from('audit_logs').select('*', { count: 'exact' });
        if (from) query = query.gte('timestamp', new Date(from).toISOString());
        if (to) query = query.lte('timestamp', new Date(to).toISOString());
        if (type) {
          const typesArray = Array.isArray(type) ? type : type.split(',').map(t => t.trim());
          query = query.in('type', typesArray);
        }
        if (cardId) query = query.eq('card_id', cardId);
        query = query.order('timestamp', { ascending: false }).order('id', { ascending: false });
        const limitNum = parseInt(limit, 10);
        let startIndex = cursor ? parseInt(cursor, 10) || 0 : 0;
        const endIndex = startIndex + limitNum - 1;
        query = query.range(startIndex, endIndex);
        const { data, count, error } = await query;
        if (!error && data) return { events: data.map(mapAuditLogFromDb), total: count };
      }
    } catch (e) {}

    let list = [...inMemory.auditLogs];
    if (from) list = list.filter(l => new Date(l.timestamp) >= new Date(from));
    if (to) list = list.filter(l => new Date(l.timestamp) <= new Date(to));
    if (type) {
      const typesArray = Array.isArray(type) ? type : type.split(',').map(t => t.trim());
      list = list.filter(l => typesArray.includes(l.type));
    }
    if (cardId) list = list.filter(l => l.cardId === cardId);
    list.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    const total = list.length;
    const startIndex = cursor ? parseInt(cursor, 10) || 0 : 0;
    const paginated = list.slice(startIndex, startIndex + parseInt(limit, 10));
    return { events: paginated, total };
  },

  async getAuditLogById(eventId) {
    try {
      if (supabase) {
        const { data, error } = await supabase.from('audit_logs').select('*').eq('id', eventId).single();
        if (!error && data) return mapAuditLogFromDb(data);
      }
    } catch (e) {}
    return inMemory.auditLogs.find(l => l.id === eventId) || null;
  },

  async addAuditLog(log) {
    if (!log) return;
    if (!log.id) {
      log.id = `evt-${crypto.randomBytes(4).toString('hex')}`;
    }
    if (!log.timestamp) {
      log.timestamp = new Date().toISOString();
    }

    // Unshift to in-memory fallback list
    inMemory.auditLogs.unshift(log);

    try {
      if (supabase) {
        const payloadToInsert = mapAuditLogToDb(log);
        const { error } = await supabase.from('audit_logs').insert(payloadToInsert);
        if (error) {
          console.error('[Supabase addAuditLog error]:', error);
        }
      }
    } catch (e) {
      console.error('[Supabase addAuditLog exception]:', e);
    }
  },


  // 7. Enrollment Sessions
  async getEnrollmentSession(id) {
    try {
      if (supabase) {
        const { data, error } = await supabase.from('enrollment_sessions').select('*').eq('id', id).single();
        if (!error && data) return mapEnrollmentSessionFromDb(data);
      }
    } catch (e) {}
    return inMemory.enrollmentSessions.get(id) || null;
  },

  async setEnrollmentSession(id, session) {
    inMemory.enrollmentSessions.set(id, session);
    try {
      if (supabase) {
        await supabase.from('enrollment_sessions').upsert(mapEnrollmentSessionToDb(session));
      }
    } catch (e) {}
  },

  async deleteEnrollmentSession(id) {
    inMemory.enrollmentSessions.delete(id);
    try {
      if (supabase) {
        await supabase.from('enrollment_sessions').delete().eq('id', id);
      }
    } catch (e) {}
  },

  // 8. Custom Metrics Helpers
  async getActiveCardCount() {
    try {
      if (supabase) {
        const { count, error } = await supabase.from('cards').select('*', { count: 'exact', head: true }).eq('status', 'active');
        if (!error && count !== null) return count;
      }
    } catch (e) {}
    return inMemory.cards.filter(c => c.status === 'active').length;
  },

  async getAuthEventsCountAndSuccessCount() {
    try {
      if (supabase) {
        const { data: allAuthEvents, error } = await supabase.from('audit_logs').select('type').in('type', ['auth_success', 'auth_fail']);
        if (!error && allAuthEvents) {
          const authCount = allAuthEvents.length;
          const successCount = allAuthEvents.filter(e => e.type === 'auth_success').length;
          return { authCount, successCount };
        }
      }
    } catch (e) {}
    const authEvents = inMemory.auditLogs.filter(l => l.type === 'auth_success' || l.type === 'auth_fail');
    return { authCount: authEvents.length, successCount: authEvents.filter(l => l.type === 'auth_success').length };
  },

  async getSpoofCount() {
    try {
      if (supabase) {
        const { count, error } = await supabase.from('audit_logs').select('*', { count: 'exact', head: true }).eq('type', 'spoof');
        if (!error && count !== null) return count;
      }
    } catch (e) {}
    return inMemory.auditLogs.filter(l => l.type === 'spoof').length;
  }
};
