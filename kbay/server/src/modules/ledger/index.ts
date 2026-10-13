// Public API of the ledger module: chart of accounts and double-entry posting.
// Inventory and finance both post through here; neither depends on the other for accounting.
export { DEFAULT_CHART, createDefaultChart, accountId, postEntry, reverseEntry, balance, findEntry, type SystemKey, type JournalLine, type JournalEntry } from './service.js';
