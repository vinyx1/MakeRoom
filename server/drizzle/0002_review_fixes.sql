ALTER TYPE "public"."change_kind" ADD VALUE 'new_booking' BEFORE 'extension';--> statement-breakpoint
ALTER TABLE "customer_constraints" ALTER COLUMN "created_at" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "payment_ops" ALTER COLUMN "created_at" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "proposals" ALTER COLUMN "created_at" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "revisions" ALTER COLUMN "created_at" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "activity_log" ADD COLUMN "seq" bigserial NOT NULL;--> statement-breakpoint
ALTER TABLE "activity_log" ADD CONSTRAINT "activity_log_seq_unique" UNIQUE("seq");--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_customerId_unique" UNIQUE("customer_id");--> statement-breakpoint
ALTER TABLE "owner_drafts" ADD CONSTRAINT "owner_drafts_bookingId_unique" UNIQUE("booking_id");