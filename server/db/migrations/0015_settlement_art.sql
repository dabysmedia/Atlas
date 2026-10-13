ALTER TABLE factions ADD COLUMN settlement_art_style text;
--> statement-breakpoint
ALTER TABLE factions ADD CONSTRAINT factions_settlement_art_style_check
CHECK (settlement_art_style IS NULL OR settlement_art_style IN ('mendoza','dupont','qadir','nhalkesh','aelari','canopy','flesh','generic'));
--> statement-breakpoint
UPDATE factions f SET settlement_art_style = CASE
  WHEN names LIKE '%mendoza%' THEN 'mendoza'
  WHEN names LIKE '%dupont%' THEN 'dupont'
  WHEN names LIKE '%qadir%' THEN 'qadir'
  WHEN names LIKE '%nhalkesh%' THEN 'nhalkesh'
  WHEN names LIKE '%aelari%' OR names LIKE '%aldari%' THEN 'aelari'
  WHEN names LIKE '%canopy%' THEN 'canopy'
  WHEN names LIKE '%fleshshapers%' THEN 'flesh'
  ELSE NULL END
FROM (SELECT f.id, regexp_replace(lower(f.name || ' ' || coalesce(p.title,'')), '[^a-z]', '', 'g') AS names
      FROM factions f LEFT JOIN wiki_pages p ON p.id=f.wiki_page_id) known
WHERE f.id=known.id;
