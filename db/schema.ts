import {sqliteTable,text,primaryKey} from 'drizzle-orm/sqlite-core';
export const preferences=sqliteTable('preferences',{owner:text('owner').notNull(),gameId:text('game_id').notNull(),data:text('data').notNull(),updated:text('updated').notNull()},t=>[primaryKey({columns:[t.owner,t.gameId]})]);
export const collectionState=sqliteTable('collection_state',{owner:text('owner').primaryKey(),settings:text('settings').notNull().default('{}'),games:text('games'),updated:text('updated').notNull()});
