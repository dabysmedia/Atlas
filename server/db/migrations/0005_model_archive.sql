CREATE TABLE "map_model_archive" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"map_id" uuid NOT NULL,
	"bytes" "bytea" NOT NULL,
	"name" text NOT NULL,
	"placement" jsonb NOT NULL,
	"version" integer NOT NULL,
	"reason" text NOT NULL,
	"archived_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "map_model_archive" ADD CONSTRAINT "map_model_archive_map_id_maps_id_fk" FOREIGN KEY ("map_id") REFERENCES "public"."maps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "map_model_archive_map_idx" ON "map_model_archive" USING btree ("map_id");