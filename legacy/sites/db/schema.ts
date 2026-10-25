import { sqliteTable, text, integer, real, primaryKey, check, index } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
export const users=sqliteTable('users',{
 id:text('id').primaryKey(),email:text('email').notNull(),displayName:text('display_name').notNull(),
 balanceCents:integer('balance_cents').notNull(),version:integer('version').notNull().default(0),createdAt:integer('created_at').notNull()
},t=>[check('balance_nonnegative',sql`${t.balanceCents} >= 0`)]);
export const markets=sqliteTable('markets',{
 id:text('id').primaryKey(),title:text('title').notNull(),category:text('category').notNull(),rules:text('rules').notNull(),
 status:text('status').notNull().default('open'),outcome:text('outcome'),liquidity:real('liquidity').notNull(),
 reserveCents:integer('reserve_cents').notNull().default(0),qYes:integer('q_yes').notNull().default(0),qNo:integer('q_no').notNull().default(0),version:integer('version').notNull().default(0),
 createdAt:integer('created_at').notNull(),closesAt:integer('closes_at').notNull(),resolvedAt:integer('resolved_at')
},t=>[check('supply_nonnegative',sql`${t.qYes} >= 0 AND ${t.qNo} >= 0`),check('reserve_nonnegative',sql`${t.reserveCents} >= 0`),check('valid_liquidity',sql`${t.liquidity} > 0`),check('valid_status',sql`${t.status} IN ('open','resolved')`),check('valid_outcome',sql`${t.outcome} IS NULL OR ${t.outcome} IN ('yes','no')`)]);
export const positions=sqliteTable('positions',{
 userId:text('user_id').notNull().references(()=>users.id),marketId:text('market_id').notNull().references(()=>markets.id),
 side:text('side').notNull(),units:integer('units').notNull().default(0)
},t=>[primaryKey({columns:[t.userId,t.marketId,t.side]}),check('holding_nonnegative',sql`${t.units} >= 0`),check('holding_side',sql`${t.side} IN ('yes','no')`)]);
export const trades=sqliteTable('trades',{
 id:text('id').primaryKey(),userId:text('user_id').notNull().references(()=>users.id),marketId:text('market_id').notNull().references(()=>markets.id),
 side:text('side').notNull(),action:text('action').notNull(),units:integer('units').notNull(),cashCents:integer('cash_cents').notNull(),
 probabilityBefore:real('probability_before').notNull(),probabilityAfter:real('probability_after').notNull(),marketVersion:integer('market_version').notNull(),createdAt:integer('created_at').notNull()
},t=>[index('trades_user_time').on(t.userId,t.createdAt),check('trade_valid',sql`${t.units} > 0 AND ${t.cashCents} >= 0 AND ${t.side} IN ('yes','no') AND ${t.action} IN ('buy','sell')`)]);
export const priceHistory=sqliteTable('price_history',{
 id:integer('id').primaryKey({autoIncrement:true}),marketId:text('market_id').notNull().references(()=>markets.id),
 probability:real('probability').notNull(),marketVersion:integer('market_version').notNull(),createdAt:integer('created_at').notNull()
},t=>[index('history_market_time').on(t.marketId,t.createdAt)]);
export const ledger=sqliteTable('ledger',{
 id:text('id').primaryKey(),userId:text('user_id').notNull().references(()=>users.id),marketId:text('market_id').references(()=>markets.id),
 kind:text('kind').notNull(),deltaCents:integer('delta_cents').notNull(),createdAt:integer('created_at').notNull()
},t=>[index('ledger_user_time').on(t.userId,t.createdAt)]);
export const bookmarks=sqliteTable('bookmarks',{
 userId:text('user_id').notNull().references(()=>users.id),marketId:text('market_id').notNull().references(()=>markets.id)
},t=>[primaryKey({columns:[t.userId,t.marketId]})]);
// A failed guard aborts the whole D1 batch. No partially applied trades.
export const transactionGuards=sqliteTable('transaction_guards',{
 id:text('id').primaryKey(),ok:integer('ok').notNull()
},t=>[check('guard_must_pass',sql`${t.ok} = 1`)]);
