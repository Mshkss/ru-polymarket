CREATE TABLE `bookmarks` (
	`user_id` text NOT NULL,
	`market_id` text NOT NULL,
	PRIMARY KEY(`user_id`, `market_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`market_id`) REFERENCES `markets`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `ledger` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`market_id` text,
	`kind` text NOT NULL,
	`delta_cents` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`market_id`) REFERENCES `markets`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `ledger_user_time` ON `ledger` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `markets` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`category` text NOT NULL,
	`rules` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`outcome` text,
	`liquidity` real NOT NULL,
 `reserve_cents` integer NOT NULL DEFAULT 0 CHECK (`reserve_cents` >= 0),
	`q_yes` integer DEFAULT 0 NOT NULL,
	`q_no` integer DEFAULT 0 NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`closes_at` integer NOT NULL,
	`resolved_at` integer,
	CONSTRAINT "supply_nonnegative" CHECK("markets"."q_yes" >= 0 AND "markets"."q_no" >= 0),
	CONSTRAINT "valid_liquidity" CHECK("markets"."liquidity" > 0),
	CONSTRAINT "valid_status" CHECK("markets"."status" IN ('open','resolved')),
	CONSTRAINT "valid_outcome" CHECK("markets"."outcome" IS NULL OR "markets"."outcome" IN ('yes','no'))
);
--> statement-breakpoint
CREATE TABLE `positions` (
	`user_id` text NOT NULL,
	`market_id` text NOT NULL,
	`side` text NOT NULL,
	`units` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`user_id`, `market_id`, `side`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`market_id`) REFERENCES `markets`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "holding_nonnegative" CHECK("positions"."units" >= 0),
	CONSTRAINT "holding_side" CHECK("positions"."side" IN ('yes','no'))
);
--> statement-breakpoint
CREATE TABLE `price_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`market_id` text NOT NULL,
	`probability` real NOT NULL,
	`market_version` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`market_id`) REFERENCES `markets`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `history_market_time` ON `price_history` (`market_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `trades` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`market_id` text NOT NULL,
	`side` text NOT NULL,
	`action` text NOT NULL,
	`units` integer NOT NULL,
	`cash_cents` integer NOT NULL,
	`probability_before` real NOT NULL,
	`probability_after` real NOT NULL,
	`market_version` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`market_id`) REFERENCES `markets`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "trade_valid" CHECK("trades"."units" > 0 AND "trades"."cash_cents" >= 0 AND "trades"."side" IN ('yes','no') AND "trades"."action" IN ('buy','sell'))
);
--> statement-breakpoint
CREATE INDEX `trades_user_time` ON `trades` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `transaction_guards` (
	`id` text PRIMARY KEY NOT NULL,
	`ok` integer NOT NULL,
	CONSTRAINT "guard_must_pass" CHECK("transaction_guards"."ok" = 1)
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`display_name` text NOT NULL,
	`balance_cents` integer NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT "balance_nonnegative" CHECK("users"."balance_cents" >= 0)
);
