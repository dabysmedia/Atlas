import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/index.js';
import { wikiLinks, wikiPages } from '../db/schema.js';
import { forbidden, logEvent, notFound } from '../history.js';
import { changed } from '../live.js';
import { docLinks, docText } from '../wikidoc.js';
import { getWorld, Uuid } from './worlds.js';

type P = { w: string; id: string };

const indexCols = {
  id: wikiPages.id, title: wikiPages.title, category: wikiPages.category, updatedAt: wikiPages.updatedAt, gmOnly: wikiPages.gmOnly,
};

/** A page of the world; for a player (`players` true), one that isn't GM-only, or "not found" as if it weren't there. */
async function getPage(db: Db, worldId: string, id: string, players = false) {
  const page = await db.query.wikiPages.findFirst({ where: and(eq(wikiPages.id, Uuid.parse(id)), eq(wikiPages.worldId, worldId)) });
  if (!page || (players && page.gmOnly)) throw notFound('Page');
  return page;
}

/** Pages a player may see. */
const forPlayers = (players: boolean) => (players ? eq(wikiPages.gmOnly, false) : undefined);

async function syncLinks(db: Db, pageId: string, worldId: string, content: unknown) {
  const targets = docLinks(content).filter((t) => Uuid.safeParse(t).success);
  await db.delete(wikiLinks).where(eq(wikiLinks.fromPageId, pageId));
  if (!targets.length) return;
  // Only link to pages that exist in the same world.
  const valid = await db.select({ id: wikiPages.id }).from(wikiPages)
    .where(and(eq(wikiPages.worldId, worldId), inArray(wikiPages.id, targets)));
  if (valid.length) await db.insert(wikiLinks).values(valid.map((v) => ({ fromPageId: pageId, toPageId: v.id }))).onConflictDoNothing();
}

const isUniqueViolation = (e: unknown) => {
  const err = e as { code?: string; cause?: { code?: string } };
  return err?.code === '23505' || err?.cause?.code === '23505';
};

export function wikiRoutes(app: FastifyInstance, db: Db) {
  /** Lightweight index of every page in the world; the client keeps it for instant title search and link chips. */
  app.get('/api/worlds/:w/pages', async (req) => {
    const w = await getWorld(db, (req.params as P).w);
    return db.select(indexCols).from(wikiPages).where(and(eq(wikiPages.worldId, w.id), forPlayers(!!req.view))).orderBy(desc(wikiPages.updatedAt));
  });

  app.get('/api/worlds/:w/pages/:id', async (req) => {
    const { w: wid, id } = req.params as P;
    const w = await getWorld(db, wid);
    const page = await getPage(db, w.id, id, !!req.view);
    const backlinks = await db.select(indexCols).from(wikiLinks)
      .innerJoin(wikiPages, eq(wikiPages.id, wikiLinks.fromPageId))
      .where(and(eq(wikiLinks.toPageId, page.id), forPlayers(!!req.view))).orderBy(wikiPages.title);
    const { search: _s, ...rest } = page;
    return { ...rest, backlinks };
  });

  const Create = z.object({
    title: z.string().trim().min(1).max(200),
    category: z.string().trim().max(60).optional(),
    content: z.unknown().optional(),
    gmOnly: z.boolean().optional(),
  });
  app.post('/api/worlds/:w/pages', async (req, reply) => {
    const w = await getWorld(db, (req.params as P).w);
    const body = Create.parse(req.body);
    // Players write pages everyone sees; hiding one is the GM's call.
    if (req.view && body.gmOnly) throw forbidden();
    const content = body.content ?? { type: 'doc', content: [{ type: 'paragraph' }] };
    try {
      const [page] = await db.insert(wikiPages).values({
        worldId: w.id, title: body.title, category: body.category || 'Lore', content, contentText: docText(content), gmOnly: body.gmOnly ?? false,
      }).returning(indexCols);
      await syncLinks(db, page.id, w.id, content);
      await logEvent(db, { worldId: w.id, kind: 'wiki.created', summary: `Wiki page "${page.title}" created`, payload: { pageId: page.id } });
      if (page.gmOnly) changed(req, { gmOnly: true });
      return page;
    } catch (e) {
      if (isUniqueViolation(e)) {
        const existing = await db.select(indexCols).from(wikiPages)
          .where(and(eq(wikiPages.worldId, w.id), sql`lower(${wikiPages.title}) = lower(${body.title})`));
        // A player is pointed at the page that has the title only if they may see it.
        const page = existing[0] && !(req.view && existing[0].gmOnly) ? existing[0] : undefined;
        return reply.code(409).send({ error: 'A page with that title already exists.', ...(page ? { page } : {}) });
      }
      throw e;
    }
  });

  const Patch = z.object({
    title: z.string().trim().min(1).max(200).optional(),
    category: z.string().trim().max(60).optional(),
    content: z.unknown().optional(),
    gmOnly: z.boolean().optional(),
  });
  app.patch('/api/worlds/:w/pages/:id', async (req, reply) => {
    const { w: wid, id } = req.params as P;
    const w = await getWorld(db, wid);
    const page = await getPage(db, w.id, id, !!req.view);
    const body = Patch.parse(req.body);
    if (req.view && body.gmOnly !== undefined) throw forbidden();
    const set: Partial<typeof wikiPages.$inferInsert> = { updatedAt: new Date() };
    if (body.title !== undefined) set.title = body.title;
    if (body.category !== undefined) set.category = body.category || 'Lore';
    if (body.content !== undefined) { set.content = body.content; set.contentText = docText(body.content); }
    if (body.gmOnly !== undefined) set.gmOnly = body.gmOnly;
    try {
      const [row] = await db.update(wikiPages).set(set).where(eq(wikiPages.id, page.id)).returning(indexCols);
      if (body.content !== undefined) await syncLinks(db, page.id, w.id, body.content);
      // Edits to a hidden page stay among the GM's screens. Hiding or showing one tells players' screens too: the
      // page comes or goes, and so do the links to it from the map and factions.
      if (row.gmOnly !== page.gmOnly) changed(req, { scopes: ['map', 'factions', 'events'] });
      else if (row.gmOnly) changed(req, { gmOnly: true });
      return row;
    } catch (e) {
      if (isUniqueViolation(e)) return reply.code(409).send({ error: 'A page with that title already exists.' });
      throw e;
    }
  });

  app.delete('/api/worlds/:w/pages/:id', async (req) => {
    const { w: wid, id } = req.params as P;
    const w = await getWorld(db, wid);
    const page = await getPage(db, w.id, id);
    await db.delete(wikiPages).where(eq(wikiPages.id, page.id));
    if (page.gmOnly) changed(req, { gmOnly: true });
    await logEvent(db, { worldId: w.id, kind: 'wiki.deleted', summary: `Wiki page "${page.title}" deleted`, payload: { pageId: page.id } });
    return { ok: true };
  });

  /**
   * Full-text search across titles and bodies. The last word is treated as a prefix
   * so results appear while typing; titles also match fuzzily via trigrams.
   */
  app.get('/api/worlds/:w/search', async (req) => {
    const w = await getWorld(db, (req.params as P).w);
    const q = z.string().max(200).parse((req.query as { q?: string }).q ?? '').trim();
    if (!q) return [];
    const words = q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
    if (!words.length) return [];
    const tsq = words.map((wd, i) => (i === words.length - 1 ? `${wd}:*` : wd)).join(' & ');
    const res = await db.execute(sql`
      select id, title, category, updated_at as "updatedAt",
        ts_headline('english', content_text, to_tsquery('english', ${tsq}),
          'StartSel=<<,StopSel=>>,MaxWords=18,MinWords=6,MaxFragments=1') as snippet,
        ts_rank(search, to_tsquery('english', ${tsq})) + similarity(title, ${q}) * 2
          + case when lower(title) = lower(${q}) then 10 when lower(title) like lower(${q}) || '%' then 3 else 0 end as score
      from wiki_pages
      where world_id = ${w.id} ${req.view ? sql`and not gm_only` : sql``}
        and (search @@ to_tsquery('english', ${tsq}) or title % ${q} or title ilike ${'%' + q.replace(/[%_]/g, '') + '%'})
      order by score desc limit 25`);
    return res.rows;
  });
}
