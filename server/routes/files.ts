import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db, DbOrTx } from '../db/index.js';
import { badRequest, logEvent, notFound } from '../history.js';
import { getWorld, Uuid } from './worlds.js';

const Kind = z.enum(['miniature', 'wiki-image', 'map-art', 'terrain', 'terrain-archive','interior','token-art', 'hex-art']);
type Kind = z.infer<typeof Kind>;
const specs = {
  'hex-art': ['hex_artwork', 'id', true],
  'token-art': ['token_portraits','id',true],
  interior: ['interior_assets','id',true],
  miniature: ['token_models', 'id', true], 'wiki-image': ['wiki_images', 'id', true],
  'map-art': ['map_art', 'map_id', false], terrain: ['map_model', 'map_id', false],
  'terrain-archive': ['map_model_archive', 'id', false],
} as const;
function source(kind: Kind, world: string, id: string) {
  const [table, key, direct] = specs[kind];
  return { table: sql.identifier(table), where: sql`${sql.identifier(key)} = ${id} and ${direct ? sql`world_id = ${world}` : sql`map_id in (select id from maps where world_id = ${world})`}` };
}
function containsImage(doc: unknown, world: string, id: string): boolean {
  if (!doc || typeof doc !== 'object') return false;
  const node = doc as { type?: string; attrs?: { src?: string }; content?: unknown[] };
  // Accept relative and absolute URLs, including cache parameters, without fetching anything.
  if (node.type === 'image' && typeof node.attrs?.src === 'string') {
    try { if (new URL(node.attrs.src, 'https://atlas.invalid').pathname === `/api/worlds/${world}/wiki-images/${id}`) return true; } catch { /* malformed external image */ }
  }
  return Array.isArray(node.content) && node.content.some(child => containsImage(child, world, id));
}
export async function listFiles(db: DbOrTx, world: string) {
  const result = await db.execute(sql`
    select id, name, octet_length(bytes) as size, 'miniature' as kind, 'model/gltf-binary' as mime, created_at as date from token_models where world_id = ${world}
    union all select id, name, octet_length(bytes), 'wiki-image', mime, created_at from wiki_images where world_id = ${world}
    union all select a.map_id, a.name, octet_length(a.bytes), 'map-art', a.mime, a.updated_at from map_art a join maps m on m.id = a.map_id where m.world_id = ${world}
    union all select a.map_id, a.name, octet_length(a.bytes), 'terrain', 'model/gltf-binary', a.updated_at from map_model a join maps m on m.id = a.map_id where m.world_id = ${world}
    union all select a.id, a.name, octet_length(a.bytes), 'terrain-archive', 'model/gltf-binary', a.archived_at from map_model_archive a join maps m on m.id = a.map_id where m.world_id = ${world}
    union all select a.id, a.name, octet_length(a.bytes), 'interior', a.mime, a.updated_at from interior_assets a where a.world_id = ${world}
    union all select id, name, octet_length(bytes), 'token-art', mime, created_at from token_portraits where world_id = ${world}
    union all select id, name, octet_length(bytes), 'hex-art', mime, created_at from hex_artwork where world_id = ${world}
    order by date desc, id`);
  const pieces = await db.execute(sql`select model_id, name from tokens where world_id = ${world} and model_id is not null`);
  const pages = await db.execute(sql`select title, content from wiki_pages where world_id = ${world}`);
  const portraits = await db.execute(sql`select name, data->>'portraitId' as portrait_id from tokens where world_id = ${world}`);
  const hexArtUses = await db.execute(sql`select p.hero_id, h.name, h.q, h.r from hex_presentations p join hexes h on h.id = p.hex_id where p.world_id = ${world}`);
  return result.rows.map(row => {
    const file = row as { id: string; name: string; size: number; kind: Kind; mime: string; date: Date };
    const uses = file.kind === 'miniature' ? pieces.rows.filter(t => t.model_id === file.id).map(t => String(t.name))
      : file.kind === 'hex-art' ? hexArtUses.rows.filter(h => h.hero_id === file.id).map(h => String(h.name || `Hex ${h.q}, ${h.r}`))
      : file.kind === 'token-art' ? portraits.rows.filter(t=>t.portrait_id===file.id).map(t=>String(t.name))
      : file.kind === 'wiki-image' ? pages.rows.filter(p => containsImage(p.content, world, file.id)).map(p => String(p.title))
      : file.kind === 'map-art' || file.kind === 'terrain' ? ['Current map'] : [];
    const blocked = file.kind === 'terrain' ? 'Remove the current terrain model in Layers first; it will become an archived file here.'
      : file.kind === 'wiki-image' && uses.length ? 'Remove this image from its wiki pages before deleting the file.' : null;
    return { ...file, uses, blocked };
  });
}
export function fileRoutes(app: FastifyInstance, db: Db) {
  app.get('/api/worlds/:w/files', async req => listFiles(db, (await getWorld(db, (req.params as { w: string }).w)).id));
  app.patch('/api/worlds/:w/files/:kind/:id', async req => {
    const p = req.params as { w: string; kind: string; id: string }, world = (await getWorld(db, p.w)).id;
    const kind = Kind.parse(p.kind), id = Uuid.parse(p.id);
    const { name } = z.object({ name: z.string().trim().min(1).max(120).regex(/^[^\\/\x00-\x1f]+$/, 'Use a file name without slashes or control characters.') }).parse(req.body);
    const src = source(kind, world, id);
    await db.transaction(async tx => {
      const result = await tx.execute(sql`update ${src.table} set name = ${name} where ${src.where} returning ${sql.identifier(specs[kind][1])}`);
      if (!result.rowCount) throw notFound('File');
      await logEvent(tx, { worldId: world, kind: 'file.renamed', summary: `Renamed uploaded file to "${name}"`, payload: { kind, id } });
    });
    return { ok: true };
  });
  app.delete('/api/worlds/:w/files/:kind/:id', async req => {
    const p = req.params as { w: string; kind: string; id: string }, world = (await getWorld(db, p.w)).id;
    const kind = Kind.parse(p.kind), id = Uuid.parse(p.id), src = source(kind, world, id);
    if ((req.query as { confirm?: string }).confirm !== 'delete') throw badRequest('Confirm permanent file deletion.');
    await db.transaction(async tx => {
      // Match wiki tree writes while checking references; no wiki content or token positions are changed.
      if (kind === 'hex-art') await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`hex-details:${world}`}))`);
      if (kind === 'wiki-image') await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`wiki:${world}`}))`);
      const file = (await listFiles(tx, world)).find(f => f.id === id && f.kind === kind);
      if (!file) throw notFound('File');
      if (file.blocked) throw Object.assign(new Error(file.blocked), { statusCode: 409 });
      // FK ON DELETE SET NULL makes assigned pieces use their existing 2D indicator.
      if (kind === 'hex-art') await tx.execute(sql`update hex_presentations set hero_id = null, revision = revision + 1, updated_at = now() where world_id = ${world} and hero_id = ${id}`);
      if(kind === 'token-art') await tx.execute(sql`update tokens set data = data - 'portraitId' where world_id = ${world} and data->>'portraitId' = ${id}`);
      await tx.execute(sql`delete from ${src.table} where ${src.where}`);
      await logEvent(tx, { worldId: world, kind: 'file.deleted', summary: `Deleted uploaded file "${file.name}"`, payload: { kind, id, affected: file.uses.length } });
    });
    return { ok: true };
  });
  app.get('/api/worlds/:w/files/:kind/:id/content', async (req, reply) => {
    const p = req.params as { w: string; kind: string; id: string }, world = (await getWorld(db, p.w)).id;
    const kind = Kind.parse(p.kind), src = source(kind, world, Uuid.parse(p.id));
    const result = await db.execute(sql`select name, bytes, ${kind === 'wiki-image' || kind === 'map-art' || kind === 'interior' || kind === 'token-art' || kind === 'hex-art' ? sql`mime` : sql`'model/gltf-binary' as mime`} from ${src.table} where ${src.where}`);
    const file = result.rows[0]; if (!file) throw notFound('File');
    return reply.header('cache-control', 'private, no-store').header('x-content-type-options', 'nosniff')
      .header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(String(file.name)).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`).type(String(file.mime)).send(file.bytes);
  });
}
