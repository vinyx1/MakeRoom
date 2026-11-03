CREATE TABLE "agent_daily_spend" (
	"day" text PRIMARY KEY NOT NULL,
	"micro_usd" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "creator_ip_hash" text;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "last_seen_at" timestamp with time zone DEFAULT now() NOT NULL;