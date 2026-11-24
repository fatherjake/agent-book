/**
 * Starts the OTLP/HTTP (JSON) collector for Claude Code telemetry.
 *
 *   npm run server      listens on 127.0.0.1:4318 (AGENT_BOOK_COLLECTOR_PORT), writes to
 *                         ~/.agent-book/telemetry.db (AGENT_BOOK_TELEMETRY_DB)
 */
import { startCollector } from './receiver.js';
import { COLLECTOR_PORT, TELEMETRY_DB_PATH, TelemetryDb } from './store.js';

const db = new TelemetryDb();
await startCollector(db);
console.log(`collector on http://127.0.0.1:${COLLECTOR_PORT} → ${TELEMETRY_DB_PATH()}`);
