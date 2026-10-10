CREATE TABLE "campaign_members" (
	"campaign_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	CONSTRAINT "campaign_members_campaign_id_user_id_pk" PRIMARY KEY("campaign_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "hexes" ADD COLUMN "party_notes" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "role" text DEFAULT 'player' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "display_name" text DEFAULT '' NOT NULL;--> statement-breakpoint
-- Every account so far was the owner's (ADMIN_USERNAME); players only exist from here on.
UPDATE "users" SET "role" = 'gm';--> statement-breakpoint
ALTER TABLE "wiki_pages" ADD COLUMN "gm_only" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "campaign_members" ADD CONSTRAINT "campaign_members_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_members" ADD CONSTRAINT "campaign_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "campaign_members_user_idx" ON "campaign_members" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_role_ck" CHECK ("users"."role" in ('gm','player'));