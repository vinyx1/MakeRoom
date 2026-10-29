CREATE TABLE "agent_dispatches" (
	"activity_seq" bigint PRIMARY KEY NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL
);
