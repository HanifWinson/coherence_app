CREATE TABLE "interest_signups" (
	"id" text PRIMARY KEY NOT NULL,
	"practice_name" text NOT NULL,
	"contact_name" text NOT NULL,
	"email" text NOT NULL,
	"role" text NOT NULL,
	"state" text,
	"locations" integer,
	"oct_vendor" text,
	"scans_per_week" text,
	"price_band" text,
	"loi" boolean DEFAULT false NOT NULL,
	"pain" text,
	"source" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "interest_signups_created_idx" ON "interest_signups" USING btree ("created_at");