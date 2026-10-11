import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db, DbOrTx } from '../db/index.js';
import { wikiImages, wikiLinks, wikiPages } from '../db/schema.js';
import { logEvent, notFound } from '../history.js';
import { docLinks, docText } from '../wikidoc.js';
import { getWorld, Uuid } from './worlds.js';
import { imageSize } from '../imagesize.js';

type P = { w: string; id: string };

const indexCols = {
  id: wikiPages.id, title: wikiPages.title, category: wikiPages.category, updatedAt: wikiPages.updatedAt,
  parentId: wikiPages.parentId, sortOrder: wikiPages.sortOrder,
};

async function getPage(db: DbOrTx, worldId: string, id: string) {
  const page = await db.query.wikiPages.findFirst({ where: and(eq(wikiPages.id, Uuid.parse(id)), eq(wikiPages.worldId, worldId)) });
  if (!page) throw notFound('Page');
  return page;
}

async function syncLinks(db: DbOrTx, pageId: string, worldId: string, content: unknown) {
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

const invalid = (message: string) => Object.assign(new Error(message), { statusCode: 400 });
const siblings = (w: string, parentId: string | null) => and(eq(wikiPages.worldId, w), parentId ? eq(wikiPages.parentId, parentId) : isNull(wikiPages.parentId));
const lockTree = (db: DbOrTx, worldId: string) => db.execute(sql`select pg_advisory_xact_lock(hashtext(${`wiki:${worldId}`}))`);
async function nextOrder(db: DbOrTx, w: string, parentId: string | null) {
  const [row] = await db.select({ max: sql<number>`coalesce(max(${wikiPages.sortOrder}), -1)` }).from(wikiPages).where(siblings(w, parentId));
  return Number(row.max) + 1;
}
async function validateParent(db: DbOrTx, worldId: string, id: string | null, parentId: string | null) {
  const seen = new Set<string>();
  let cursor = parentId;
  while (cursor) {
    if (cursor === id || seen.has(cursor)) throw invalid('A page cannot be placed inside itself or one of its children.');
    seen.add(cursor);
    const parent = await getPage(db, worldId, cursor);
    cursor = parent.parentId;
  }
}

export function wikiRoutes(app: FastifyInstance, db: Db) {
  app.post('/api/worlds/:w/wiki-images', { bodyLimit: 10 * 1024 * 1024 }, async (req) => {
    const w = await getWorld(db, (req.params as P).w);
    const bytes = req.body;
    const info = Buffer.isBuffer(bytes) && imageSize(bytes);
    if (!info || !info.width || !info.height || info.width * info.height > 40_000_000) throw invalid('Use a PNG, JPEG, WebP or GIF up to 10 MB and 40 megapixels.');
    const [image] = await db.insert(wikiImages).values({ worldId: w.id, name: z.string().trim().min(1).max(120).parse((req.query as { name?: string }).name ?? 'wiki-image'), bytes: bytes as Buffer, ...info }).returning({ id: wikiImages.id, width: wikiImages.width, height: wikiImages.height });
    return { ...image, src: `/api/worlds/${w.id}/wiki-images/${image.id}` };
  });
  app.get('/api/worlds/:w/wiki-images/:id', async (req, reply) => {
    const { w: wid, id } = req.params as P, w = await getWorld(db, wid);
    const image = await db.query.wikiImages.findFirst({ where: and(eq(wikiImages.id, Uuid.parse(id)), eq(wikiImages.worldId, w.id)) });
    if (!image) throw notFound('Wiki image');
    return reply.header('cache-control', 'private, max-age=31536000, immutable').header('x-content-type-options', 'nosniff').type(image.mime).send(image.bytes);
  });

  app.post('/api/worlds/:w/pages/reorder', async (req) => {
    const w = await getWorld(db, (req.params as P).w);
    const body = z.object({ parentId: Uuid.nullable(), ids: z.array(Uuid).max(10_000) }).parse(req.body);
    return db.transaction(async (tx) => {
      await lockTree(tx, w.id);
      if (body.parentId) await getPage(tx, w.id, body.parentId);
      const rows = await tx.select({ id: wikiPages.id }).from(wikiPages).where(siblings(w.id, body.parentId));
      if (new Set(body.ids).size !== body.ids.length || rows.length !== body.ids.length || rows.some(row => !body.ids.includes(row.id))) throw invalid('Reorder must contain each sibling exactly once. Refresh the page list and try again.');
      for (const [sortOrder, id] of body.ids.entries()) await tx.update(wikiPages).set({ sortOrder }).where(eq(wikiPages.id, id));
      return { ok: true };
    });
  });
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
    parentId: Uuid.nullable().optional(),
  });
  app.post('/api/worlds/:w/pages', async (req, reply) => {
    const w = await getWorld(db, (req.params as P).w);
    const body = Create.parse(req.body);
    const content = body.content ?? { type: 'doc', content: [{ type: 'paragraph' }] };
    try {
      return await db.transaction(async (tx) => {
        await lockTree(tx, w.id);
        const parentId = body.parentId ?? null;
        await validateParent(tx, w.id, null, parentId);
        const [page] = await tx.insert(wikiPages).values({
          worldId: w.id, title: body.title, category: body.category || 'Lore', content, contentText: docText(content),
          parentId, sortOrder: await nextOrder(tx, w.id, parentId),
        }).returning(indexCols);
        await syncLinks(tx, page.id, w.id, content);
        await logEvent(tx, { worldId: w.id, kind: 'wiki.created', summary: `Wiki page "${page.title}" created`, payload: { pageId: page.id } });
        return page;
      });
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
    parentId: Uuid.nullable().optional(),
  });
  app.patch('/api/worlds/:w/pages/:id', async (req, reply) => {
    const { w: wid, id } = req.params as P;
    const w = await getWorld(db, wid);
    const body = Patch.parse(req.body);
    const set: Partial<typeof wikiPages.$inferInsert> = { updatedAt: new Date() };
    if (body.title !== undefined) set.title = body.title;
    if (body.category !== undefined) set.category = body.category || 'Lore';
    if (body.content !== undefined) { set.content = body.content; set.contentText = docText(body.content); }
    try {
      return await db.transaction(async (tx) => {
        await lockTree(tx, w.id);
        const page = await getPage(tx, w.id, id);
        if (body.parentId !== undefined && body.parentId !== page.parentId) {
          await validateParent(tx, w.id, page.id, body.parentId);
          set.parentId = body.parentId; set.sortOrder = await nextOrder(tx, w.id, body.parentId);
        }
        const [row] = await tx.update(wikiPages).set(set).where(eq(wikiPages.id, page.id)).returning(indexCols);
        if (body.content !== undefined) await syncLinks(tx, page.id, w.id, body.content);
        return row;
      });
    } catch (e) {
      if (isUniqueViolation(e)) return reply.code(409).send({ error: 'A page with that title already exists.' });
      throw e;
    }
  });

  app.delete('/api/worlds/:w/pages/:id', async (req) => {
    const { w: wid, id } = req.params as P;
    const w = await getWorld(db, wid);
    return db.transaction(async (tx) => {
      await lockTree(tx, w.id);
      const page = await getPage(tx, w.id, id);
      const children = await tx.select(indexCols).from(wikiPages).where(siblings(w.id, page.id)).orderBy(wikiPages.sortOrder, wikiPages.title);
      let order = await nextOrder(tx, w.id, page.parentId);
      for (const child of children) await tx.update(wikiPages).set({ parentId: page.parentId, sortOrder: order++ }).where(eq(wikiPages.id, child.id));
      await tx.delete(wikiPages).where(eq(wikiPages.id, page.id));
      await logEvent(tx, { worldId: w.id, kind: 'wiki.deleted', summary: `Wiki page "${page.title}" deleted`, payload: { pageId: page.id } });
      return { ok: true };
    });
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
      select id, title, category, updated_at as "updatedAt", parent_id as "parentId", sort_order as "sortOrder",
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
