import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/index.js';
import { wikiLinks, wikiPages } from '../db/schema.js';
import { logEvent, notFound } from '../history.js';
import { docLinks, docText } from '../wikidoc.js';
import { getWorld, Uuid } from './worlds.js';

type P = { w: string; id: string };

const indexCols = {
  id: wikiPages.id, title: wikiPages.title, category: wikiPages.category, updatedAt: wikiPages.updatedAt,
};

async function getPage(db: Db, worldId: string, id: string) {
  const page = await db.query.wikiPages.findFirst({ where: and(eq(wikiPages.id, Uuid.parse(id)), eq(wikiPages.worldId, worldId)) });
  if (!page) throw notFound('Page');
  return page;
}

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
    return db.select(indexCols).from(wikiPages).where(eq(wikiPages.worldId, w.id)).orderBy(desc(wikiPages.updatedAt));
  });

  app.get('/api/worlds/:w/pages/:id', async (req) => {
    const { w: wid, id } = req.params as P;
    const w = await getWorld(db, wid);
    const page = await getPage(db, w.id, id);
    const backlinks = await db.select(indexCols).from(wikiLinks)
      .innerJoin(wikiPages, eq(wikiPages.id, wikiLinks.fromPageId))
      .where(eq(wikiLinks.toPageId, page.id)).orderBy(wikiPages.title);
    const { search: _s, ...rest } = page;
    return { ...rest, backlinks };
  });

  const Create = z.object({
    title: z.string().trim().min(1).max(200),
    category: z.string().trim().max(60).optional(),
    content: z.unknown().optional(),
  });
  app.post('/api/worlds/:w/pages', async (req, reply) => {
    const w = await getWorld(db, (req.params as P).w);
    const body = Create.parse(req.body);
    const content = body.content ?? { type: 'doc', content: [{ type: 'paragraph' }] };
    try {
      const [page] = await db.insert(wikiPages).values({
        worldId: w.id, title: body.title, category: body.category || 'Lore', content, contentText: docText(content),
      }).returning(indexCols);
      await syncLinks(db, page.id, w.id, content);
      await logEvent(db, { worldId: w.id, kind: 'wiki.created', summary: `Wiki page "${page.title}" created`, payload: { pageId: page.id } });
      return page;
    } catch (e) {
      if (isUniqueViolation(e)) {
        const existing = await db.select(indexCols).from(wikiPages)
          .where(and(eq(wikiPages.worldId, w.id), sql`lower(${wikiPages.title}) = lower(${body.title})`));
        return reply.code(409).send({ error: 'A page with that title already exists.', page: existing[0] });
      }
      throw e;
    }
  });

  const Patch = z.object({
    title: z.string().trim().min(1).max(200).optional(),
    category: z.string().trim().max(60).optional(),
    content: z.unknown().optional(),
  });
  app.patch('/api/worlds/:w/pages/:id', async (req, reply) => {
    const { w: wid, id } = req.params as P;
    const w = await getWorld(db, wid);
    const page = await getPage(db, w.id, id);
    const body = Patch.parse(req.body);
    const set: Partial<typeof wikiPages.$inferInsert> = { updatedAt: new Date() };
    if (body.title !== undefined) set.title = body.title;
    if (body.category !== undefined) set.category = body.category || 'Lore';
    if (body.content !== undefined) { set.content = body.content; set.contentText = docText(body.content); }
    try {
      const [row] = await db.update(wikiPages).set(set).where(eq(wikiPages.id, page.id)).returning(indexCols);
      if (body.content !== undefined) await syncLinks(db, page.id, w.id, body.content);
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
      where world_id = ${w.id}
        and (search @@ to_tsquery('english', ${tsq}) or title % ${q} or title ilike ${'%' + q.replace(/[%_]/g, '') + '%'})
      order by score desc limit 25`);
    return res.rows;
  });
}
