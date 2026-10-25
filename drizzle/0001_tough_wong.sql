PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_markets` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`category` text NOT NULL,
	`rules` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`outcome` text,
	`liquidity` real NOT NULL,
	`reserve_cents` integer DEFAULT 0 NOT NULL,
	`q_yes` integer DEFAULT 0 NOT NULL,
	`q_no` integer DEFAULT 0 NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`closes_at` integer NOT NULL,
	`resolved_at` integer,
	CONSTRAINT "supply_nonnegative" CHECK("__new_markets"."q_yes" >= 0 AND "__new_markets"."q_no" >= 0),
	CONSTRAINT "reserve_nonnegative" CHECK("__new_markets"."reserve_cents" >= 0),
	CONSTRAINT "valid_liquidity" CHECK("__new_markets"."liquidity" > 0),
	CONSTRAINT "valid_status" CHECK("__new_markets"."status" IN ('open','resolved')),
	CONSTRAINT "valid_outcome" CHECK("__new_markets"."outcome" IS NULL OR "__new_markets"."outcome" IN ('yes','no'))
);
--> statement-breakpoint
INSERT INTO `__new_markets`("id", "title", "category", "rules", "status", "outcome", "liquidity", "reserve_cents", "q_yes", "q_no", "version", "created_at", "closes_at", "resolved_at") SELECT "id", "title", "category", "rules", "status", "outcome", "liquidity", "reserve_cents", "q_yes", "q_no", "version", "created_at", "closes_at", "resolved_at" FROM `markets`;--> statement-breakpoint
DROP TABLE `markets`;--> statement-breakpoint
ALTER TABLE `__new_markets` RENAME TO `markets`;--> statement-breakpoint
PRAGMA foreign_keys=ON;