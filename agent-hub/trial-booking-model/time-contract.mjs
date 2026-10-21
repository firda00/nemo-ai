import assert from 'node:assert/strict';
import { modelSchedule } from './chat-server.mjs';
const rows = [
  { id: 'synthetic-1', starts_at: '2026-09-20T10:00:00Z', timezone: 'Asia/Tashkent', available: 3 },
  { id: 'synthetic-2', starts_at: '2026-09-20T22:30:00Z', timezone: 'Asia/Tashkent', available: 0 },
];
const result = modelSchedule(rows);
assert.equal(result[0].local_starts_at, '2026-09-20 15:00');
assert.equal(result[1].local_starts_at, '2026-09-21 03:30');
assert.equal(result[1].available, 0);
assert.equal(rows[0].local_starts_at, undefined);
assert.equal(result[0].starts_at, undefined, 'Do not expose conflicting UTC clock alongside local model-facing time');
assert.equal(rows[0].starts_at, '2026-09-20T10:00:00Z', 'Canonical schedule stays unchanged');
console.log('PASS: six offline schedule-time assertions; no model or network calls.');
