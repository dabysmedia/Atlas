ALTER TABLE "maps" ADD COLUMN "model_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "maps" ADD COLUMN "art_version" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
UPDATE maps SET model_version = greatest(
  coalesce((SELECT max(version) FROM map_model WHERE map_id = maps.id), 0),
  coalesce((SELECT max(version) FROM map_model_archive WHERE map_id = maps.id), 0)
), art_version = coalesce((SELECT version FROM map_art WHERE map_id = maps.id), 0);
