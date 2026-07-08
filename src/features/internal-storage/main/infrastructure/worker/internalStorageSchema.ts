import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const stallJournalEntries = sqliteTable(
  'stall_journal_entries',
  {
    teamName: text('team_name').notNull(),
    epochKey: text('epoch_key').notNull(),
    taskId: text('task_id').notNull(),
    memberName: text('member_name'),
    branch: text('branch').notNull(),
    signal: text('signal').notNull(),
    state: text('state').notNull(),
    consecutiveScans: integer('consecutive_scans').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    alertedAt: text('alerted_at'),
  },
  (table) => [primaryKey({ columns: [table.teamName, table.epochKey] })]
);

export const storeImports = sqliteTable(
  'store_imports',
  {
    storeId: text('store_id').notNull(),
    teamName: text('team_name').notNull(),
    importedAt: text('imported_at').notNull(),
    entryCount: integer('entry_count').notNull(),
  },
  (table) => [primaryKey({ columns: [table.storeId, table.teamName] })]
);
