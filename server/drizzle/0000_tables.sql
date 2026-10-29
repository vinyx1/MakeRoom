CREATE TYPE "public"."approval_role" AS ENUM('requester', 'affected', 'owner');--> statement-breakpoint
CREATE TYPE "public"."approval_source" AS ENUM('card_click', 'owner_attested', 'counter_author', 'carried_over');--> statement-breakpoint
CREATE TYPE "public"."approval_status" AS ENUM('pending', 'approved', 'rejected', 'countered', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."booking_status" AS ENUM('confirmed', 'picked_up', 'returned', 'cancelled', 'no_show');--> statement-breakpoint
CREATE TYPE "public"."change_action" AS ENUM('create', 'update', 'cancel', 'unassign', 'assign');--> statement-breakpoint
CREATE TYPE "public"."change_kind" AS ENUM('extension', 'time_shift', 'same_model_swap', 'model_change', 'cancellation');--> statement-breakpoint
CREATE TYPE "public"."compensation_kind" AS ENUM('refund', 'upgrade_value');--> statement-breakpoint
CREATE TYPE "public"."constraint_kind" AS ENUM('not_before', 'not_after', 'require_model', 'forbid_model', 'keep_unit');--> statement-breakpoint
CREATE TYPE "public"."escalation_kind" AS ENUM('approval', 'fact_question', 'plan_review', 'handoff', 'overdue', 'no_show', 'unassigned', 'payment_failure');--> statement-breakpoint
CREATE TYPE "public"."escalation_status" AS ENUM('open', 'resolved');--> statement-breakpoint
CREATE TYPE "public"."fact_source" AS ENUM('seed', 'owner');--> statement-breakpoint
CREATE TYPE "public"."fact_value" AS ENUM('yes', 'no', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."message_author" AS ENUM('customer', 'agent', 'owner', 'system');--> statement-breakpoint
CREATE TYPE "public"."payment_op_kind" AS ENUM('authorize', 'capture', 'void', 'refund');--> statement-breakpoint
CREATE TYPE "public"."payment_op_status" AS ENUM('pending', 'succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."paypal_intent" AS ENUM('AUTHORIZE', 'CAPTURE');--> statement-breakpoint
CREATE TYPE "public"."paypal_order_status" AS ENUM('created', 'approved', 'authorized', 'captured', 'voided', 'failed');--> statement-breakpoint
CREATE TYPE "public"."proposal_source" AS ENUM('customer_request', 'owner_edit', 'owner_resolve', 'unit_down', 'overdue', 'customer_cancel');--> statement-breakpoint
CREATE TYPE "public"."proposal_state" AS ENUM('DRAFT', 'AWAITING_APPROVALS', 'CAPTURING', 'COMMITTED', 'REJECTED', 'EXPIRED', 'CANCELLED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."revision_author" AS ENUM('agent', 'owner', 'customer');--> statement-breakpoint
CREATE TYPE "public"."revision_origin" AS ENUM('optimizer', 'counter', 'owner_modify', 'fallback', 'alternative');--> statement-breakpoint
CREATE TYPE "public"."revision_status" AS ENUM('draft', 'offered', 'selected', 'superseded', 'dropped');--> statement-breakpoint
CREATE TYPE "public"."unavailability_reason" AS ENUM('maintenance', 'out_of_service');--> statement-breakpoint
CREATE TABLE "activity_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"actor" text NOT NULL,
	"kind" text NOT NULL,
	"proposal_id" uuid,
	"revision_id" uuid,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"proposal_id" uuid NOT NULL,
	"role" "approval_role" NOT NULL,
	"customer_id" uuid,
	"status" "approval_status" DEFAULT 'pending' NOT NULL,
	"refusal" boolean DEFAULT false NOT NULL,
	"source" "approval_source",
	"carried_from_id" uuid,
	"requested_at" timestamp with time zone NOT NULL,
	"responded_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	CONSTRAINT "approvals_revisionId_role_customerId_unique" UNIQUE NULLS NOT DISTINCT("revision_id","role","customer_id"),
	CONSTRAINT "approvals_owner_has_no_customer" CHECK (("approvals"."role" = 'owner') = ("approvals"."customer_id" IS NULL)),
	CONSTRAINT "approvals_refusal_is_rejection" CHECK (NOT "approvals"."refusal" OR "approvals"."status" = 'rejected')
);
--> statement-breakpoint
CREATE TABLE "bookings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"model_id" uuid NOT NULL,
	"unit_id" uuid,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"buffer_ends_at" timestamp with time zone NOT NULL,
	"status" "booking_status" NOT NULL,
	"overdue_marked_at" timestamp with time zone,
	"no_show_marked_at" timestamp with time zone,
	"price_cents" integer NOT NULL,
	"prepaid_order_id" uuid,
	"note" text,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "bookings_ends_after_start" CHECK ("bookings"."ends_at" > "bookings"."starts_at"),
	CONSTRAINT "bookings_buffer_after_end" CHECK ("bookings"."buffer_ends_at" >= "bookings"."ends_at")
);
--> statement-breakpoint
CREATE TABLE "claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"proposal_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"booking_id" uuid,
	"unit_id" uuid,
	"period" "tstzrange",
	"released_at" timestamp with time zone,
	CONSTRAINT "claims_booking_xor_capacity" CHECK (("claims"."booking_id" IS NOT NULL AND "claims"."unit_id" IS NULL AND "claims"."period" IS NULL)
       OR ("claims"."booking_id" IS NULL AND "claims"."unit_id" IS NOT NULL AND "claims"."period" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "condition_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"unit_id" uuid NOT NULL,
	"body" text NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"handed_off_at" timestamp with time zone,
	"handoff_reason" text,
	"handed_back_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "customer_constraints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"proposal_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"kind" "constraint_kind" NOT NULL,
	"value" jsonb NOT NULL,
	"source_message_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"flagged" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "equipment_models" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"name" text NOT NULL,
	"category" text NOT NULL,
	"tier" integer NOT NULL,
	"daily_rate_cents" integer NOT NULL,
	"rate_min_cents" integer NOT NULL,
	"rate_max_cents" integer NOT NULL,
	CONSTRAINT "equipment_models_shopId_name_unique" UNIQUE("shop_id","name"),
	CONSTRAINT "equipment_models_rate_in_bounds" CHECK ("equipment_models"."rate_min_cents" <= "equipment_models"."daily_rate_cents" AND "equipment_models"."daily_rate_cents" <= "equipment_models"."rate_max_cents")
);
--> statement-breakpoint
CREATE TABLE "escalations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"kind" "escalation_kind" NOT NULL,
	"proposal_id" uuid,
	"revision_id" uuid,
	"conversation_id" uuid,
	"fact_id" uuid,
	"booking_id" uuid,
	"reasons" text[] DEFAULT '{}' NOT NULL,
	"summary" text NOT NULL,
	"status" "escalation_status" DEFAULT 'open' NOT NULL,
	"resolution" jsonb,
	"at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "facts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"unit_id" uuid,
	"model_id" uuid,
	"key" text NOT NULL,
	"value" "fact_value" NOT NULL,
	"source" "fact_source" NOT NULL,
	"set_at" timestamp with time zone NOT NULL,
	"escalation_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "facts_shopId_unitId_modelId_key_unique" UNIQUE NULLS NOT DISTINCT("shop_id","unit_id","model_id","key"),
	CONSTRAINT "facts_unit_xor_model" CHECK (("facts"."unit_id" IS NULL) <> ("facts"."model_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"author" "message_author" NOT NULL,
	"body" text NOT NULL,
	"card_revision_ids" uuid[] DEFAULT '{}' NOT NULL,
	"is_owner_draft" boolean DEFAULT false NOT NULL,
	"at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_substitutes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"model_id" uuid NOT NULL,
	"substitute_model_id" uuid NOT NULL,
	CONSTRAINT "model_substitutes_modelId_substituteModelId_unique" UNIQUE("model_id","substitute_model_id"),
	CONSTRAINT "model_substitutes_not_self" CHECK ("model_substitutes"."model_id" <> "model_substitutes"."substitute_model_id")
);
--> statement-breakpoint
CREATE TABLE "owner_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"booking_id" uuid NOT NULL,
	"proposed" jsonb NOT NULL,
	"based_on_version" integer NOT NULL,
	"attested_customer_ids" uuid[] DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_ops" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"kind" "payment_op_kind" NOT NULL,
	"paypal_order_ref" uuid NOT NULL,
	"amount_cents" integer NOT NULL,
	"request_id" text NOT NULL,
	"status" "payment_op_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"paypal_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_ops_requestId_unique" UNIQUE("request_id")
);
--> statement-breakpoint
CREATE TABLE "paypal_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"proposal_id" uuid,
	"revision_id" uuid,
	"booking_id" uuid,
	"customer_id" uuid NOT NULL,
	"paypal_order_id" text NOT NULL,
	"intent" "paypal_intent" NOT NULL,
	"amount_cents" integer NOT NULL,
	"authorization_id" text,
	"capture_id" text,
	"captured_cents" integer DEFAULT 0 NOT NULL,
	"refunded_cents" integer DEFAULT 0 NOT NULL,
	"status" "paypal_order_status" DEFAULT 'created' NOT NULL,
	"simulated" boolean DEFAULT false NOT NULL,
	CONSTRAINT "paypal_orders_paypalOrderId_unique" UNIQUE("paypal_order_id"),
	CONSTRAINT "paypal_orders_amounts" CHECK (0 <= "paypal_orders"."refunded_cents" AND "paypal_orders"."refunded_cents" <= "paypal_orders"."captured_cents" AND "paypal_orders"."captured_cents" <= "paypal_orders"."amount_cents")
);
--> statement-breakpoint
CREATE TABLE "proposal_exclusions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"proposal_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"reason" text NOT NULL,
	CONSTRAINT "proposal_exclusions_proposalId_customerId_unique" UNIQUE("proposal_id","customer_id")
);
--> statement-breakpoint
CREATE TABLE "proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"source" "proposal_source" NOT NULL,
	"requester_customer_id" uuid,
	"subject_booking_id" uuid,
	"request" jsonb NOT NULL,
	"state" "proposal_state" DEFAULT 'DRAFT' NOT NULL,
	"revision_seq" integer DEFAULT 0 NOT NULL,
	"fallback_plans_used" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone,
	"ended_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "revision_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"booking_id" uuid,
	"action" "change_action" NOT NULL,
	"before" jsonb,
	"new_unit_id" uuid,
	"new_model_id" uuid,
	"new_starts_at" timestamp with time zone,
	"new_ends_at" timestamp with time zone,
	"new_buffer_ends_at" timestamp with time zone,
	"kind" "change_kind" NOT NULL,
	"requires_approval" boolean NOT NULL,
	"hours_shifted" numeric DEFAULT 0 NOT NULL,
	"party_customer_id" uuid NOT NULL,
	"price_delta_cents" integer DEFAULT 0 NOT NULL,
	"compensation_cents" integer DEFAULT 0 NOT NULL,
	"compensation_kind" "compensation_kind",
	CONSTRAINT "revision_changes_booking_unless_create" CHECK (("revision_changes"."action" = 'create') = ("revision_changes"."booking_id" IS NULL)),
	CONSTRAINT "revision_changes_before_unless_create" CHECK (("revision_changes"."action" = 'create') = ("revision_changes"."before" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"proposal_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"option_label" text,
	"parent_revision_id" uuid,
	"status" "revision_status" DEFAULT 'draft' NOT NULL,
	"origin" "revision_origin" NOT NULL,
	"created_by" "revision_author" NOT NULL,
	"created_by_customer_id" uuid,
	"is_alternative" boolean DEFAULT false NOT NULL,
	"quote" jsonb NOT NULL,
	"net_revenue_cents" integer NOT NULL,
	"owner_triggers" text[] DEFAULT '{}' NOT NULL,
	"envelope_trips" text[] DEFAULT '{}' NOT NULL,
	"needs_owner" boolean DEFAULT false NOT NULL,
	"fact_dependencies" uuid[] DEFAULT '{}' NOT NULL,
	"fingerprint" jsonb,
	"validated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "revisions_proposalId_seq_optionLabel_unique" UNIQUE NULLS NOT DISTINCT("proposal_id","seq","option_label"),
	CONSTRAINT "revisions_option_label" CHECK ("revisions"."option_label" IN ('A', 'B')),
	CONSTRAINT "revisions_customer_author" CHECK (("revisions"."created_by" = 'customer') = ("revisions"."created_by_customer_id" IS NOT NULL)),
	CONSTRAINT "revisions_needs_owner" CHECK ("revisions"."needs_owner" = (cardinality("revisions"."owner_triggers") > 0 OR cardinality("revisions"."envelope_trips") > 0))
);
--> statement-breakpoint
CREATE TABLE "shops" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"timezone" text NOT NULL,
	"opens_at" time NOT NULL,
	"closes_at" time NOT NULL,
	"clock_offset_ms" bigint DEFAULT 0 NOT NULL,
	"policy" jsonb NOT NULL,
	"agent_turns_used" integer DEFAULT 0 NOT NULL,
	"session_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shops_sessionKey_unique" UNIQUE("session_key")
);
--> statement-breakpoint
CREATE TABLE "unit_unavailability" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"unit_id" uuid NOT NULL,
	"period" "tstzrange" NOT NULL,
	"reason" "unavailability_reason" NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "units" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"model_id" uuid NOT NULL,
	"label" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "units_shopId_label_unique" UNIQUE("shop_id","label")
);
--> statement-breakpoint
ALTER TABLE "activity_log" ADD CONSTRAINT "activity_log_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_log" ADD CONSTRAINT "activity_log_proposal_id_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_log" ADD CONSTRAINT "activity_log_revision_id_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_revision_id_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_proposal_id_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_carried_from_id_approvals_id_fk" FOREIGN KEY ("carried_from_id") REFERENCES "public"."approvals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_model_id_equipment_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."equipment_models"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_unit_id_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_prepaid_order_id_paypal_orders_id_fk" FOREIGN KEY ("prepaid_order_id") REFERENCES "public"."paypal_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_proposal_id_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_revision_id_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_unit_id_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "condition_notes" ADD CONSTRAINT "condition_notes_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "condition_notes" ADD CONSTRAINT "condition_notes_unit_id_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."units"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_constraints" ADD CONSTRAINT "customer_constraints_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_constraints" ADD CONSTRAINT "customer_constraints_proposal_id_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_constraints" ADD CONSTRAINT "customer_constraints_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_constraints" ADD CONSTRAINT "customer_constraints_source_message_id_messages_id_fk" FOREIGN KEY ("source_message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "equipment_models" ADD CONSTRAINT "equipment_models_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escalations" ADD CONSTRAINT "escalations_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escalations" ADD CONSTRAINT "escalations_proposal_id_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escalations" ADD CONSTRAINT "escalations_revision_id_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escalations" ADD CONSTRAINT "escalations_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escalations" ADD CONSTRAINT "escalations_fact_id_facts_id_fk" FOREIGN KEY ("fact_id") REFERENCES "public"."facts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escalations" ADD CONSTRAINT "escalations_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facts" ADD CONSTRAINT "facts_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facts" ADD CONSTRAINT "facts_unit_id_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."units"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facts" ADD CONSTRAINT "facts_model_id_equipment_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."equipment_models"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facts" ADD CONSTRAINT "facts_escalation_id_escalations_id_fk" FOREIGN KEY ("escalation_id") REFERENCES "public"."escalations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_substitutes" ADD CONSTRAINT "model_substitutes_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_substitutes" ADD CONSTRAINT "model_substitutes_model_id_equipment_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."equipment_models"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_substitutes" ADD CONSTRAINT "model_substitutes_substitute_model_id_equipment_models_id_fk" FOREIGN KEY ("substitute_model_id") REFERENCES "public"."equipment_models"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_drafts" ADD CONSTRAINT "owner_drafts_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_drafts" ADD CONSTRAINT "owner_drafts_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_ops" ADD CONSTRAINT "payment_ops_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_ops" ADD CONSTRAINT "payment_ops_paypal_order_ref_paypal_orders_id_fk" FOREIGN KEY ("paypal_order_ref") REFERENCES "public"."paypal_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paypal_orders" ADD CONSTRAINT "paypal_orders_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paypal_orders" ADD CONSTRAINT "paypal_orders_proposal_id_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paypal_orders" ADD CONSTRAINT "paypal_orders_revision_id_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paypal_orders" ADD CONSTRAINT "paypal_orders_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paypal_orders" ADD CONSTRAINT "paypal_orders_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_exclusions" ADD CONSTRAINT "proposal_exclusions_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_exclusions" ADD CONSTRAINT "proposal_exclusions_proposal_id_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_exclusions" ADD CONSTRAINT "proposal_exclusions_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_requester_customer_id_customers_id_fk" FOREIGN KEY ("requester_customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_subject_booking_id_bookings_id_fk" FOREIGN KEY ("subject_booking_id") REFERENCES "public"."bookings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revision_changes" ADD CONSTRAINT "revision_changes_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revision_changes" ADD CONSTRAINT "revision_changes_revision_id_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revision_changes" ADD CONSTRAINT "revision_changes_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revision_changes" ADD CONSTRAINT "revision_changes_new_unit_id_units_id_fk" FOREIGN KEY ("new_unit_id") REFERENCES "public"."units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revision_changes" ADD CONSTRAINT "revision_changes_new_model_id_equipment_models_id_fk" FOREIGN KEY ("new_model_id") REFERENCES "public"."equipment_models"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revision_changes" ADD CONSTRAINT "revision_changes_party_customer_id_customers_id_fk" FOREIGN KEY ("party_customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revisions" ADD CONSTRAINT "revisions_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revisions" ADD CONSTRAINT "revisions_proposal_id_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revisions" ADD CONSTRAINT "revisions_parent_revision_id_revisions_id_fk" FOREIGN KEY ("parent_revision_id") REFERENCES "public"."revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revisions" ADD CONSTRAINT "revisions_created_by_customer_id_customers_id_fk" FOREIGN KEY ("created_by_customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unit_unavailability" ADD CONSTRAINT "unit_unavailability_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unit_unavailability" ADD CONSTRAINT "unit_unavailability_unit_id_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."units"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "units" ADD CONSTRAINT "units_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "units" ADD CONSTRAINT "units_model_id_equipment_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."equipment_models"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activity_log_shop_id_at_index" ON "activity_log" USING btree ("shop_id","at");--> statement-breakpoint
CREATE INDEX "approvals_proposal_id_index" ON "approvals" USING btree ("proposal_id");--> statement-breakpoint
CREATE INDEX "bookings_shop_id_starts_at_index" ON "bookings" USING btree ("shop_id","starts_at");--> statement-breakpoint
CREATE INDEX "claims_revision_id_index" ON "claims" USING btree ("revision_id");--> statement-breakpoint
CREATE INDEX "condition_notes_unit_id_index" ON "condition_notes" USING btree ("unit_id");--> statement-breakpoint
CREATE INDEX "customer_constraints_proposal_id_index" ON "customer_constraints" USING btree ("proposal_id");--> statement-breakpoint
CREATE INDEX "escalations_shop_id_status_index" ON "escalations" USING btree ("shop_id","status");--> statement-breakpoint
CREATE INDEX "messages_conversation_id_at_index" ON "messages" USING btree ("conversation_id","at");--> statement-breakpoint
CREATE INDEX "payment_ops_paypal_order_ref_index" ON "payment_ops" USING btree ("paypal_order_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "proposals_one_active_per_requester_booking" ON "proposals" USING btree ("requester_customer_id","subject_booking_id") WHERE "proposals"."state" IN ('DRAFT', 'AWAITING_APPROVALS', 'CAPTURING');--> statement-breakpoint
CREATE INDEX "proposals_shop_id_state_index" ON "proposals" USING btree ("shop_id","state");--> statement-breakpoint
CREATE INDEX "revision_changes_revision_id_index" ON "revision_changes" USING btree ("revision_id");--> statement-breakpoint
CREATE INDEX "unit_unavailability_unit_id_index" ON "unit_unavailability" USING btree ("unit_id");