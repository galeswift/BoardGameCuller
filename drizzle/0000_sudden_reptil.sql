CREATE TABLE `collection_state` (
	`owner` text PRIMARY KEY NOT NULL,
	`settings` text DEFAULT '{}' NOT NULL,
	`games` text,
	`updated` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `preferences` (
	`owner` text NOT NULL,
	`game_id` text NOT NULL,
	`data` text NOT NULL,
	`updated` text NOT NULL,
	PRIMARY KEY(`owner`, `game_id`)
);
