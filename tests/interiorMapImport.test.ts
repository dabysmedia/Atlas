import { afterEach, describe, expect, it, vi } from 'vitest';
import { gridDimensions, uploadInteriorMap } from '../client/src/interiors/mapImport';

vi.mock('../client/src/api', () => ({ clientHeaders: { 'x-atlas-client': 'test' }, pendingWrites: { track: <T>(promise: Promise<T>) => promise } }));
afterEach(() => vi.unstubAllGlobals());

describe('local map import', () => {
  it('uses full squares around offset art, preserving the whole image', () => {
    expect(gridDimensions(600, 500, { size: 50, x: 0, y: 0 })).toEqual({ cols: 12, rows: 10 });
    expect(gridDimensions(600, 500, { size: 50, x: 10, y: 25 })).toEqual({ cols: 13, rows: 11 });
    expect(gridDimensions(601, 503, { size: 50.5, x: 2, y: 0 })).toEqual({ cols: 12, rows: 10 });
  });

  it('uploads files without a browser MIME type and encodes Unicode filenames safely', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ name: '洞窟.png', mime: 'image/png', version: 1 })));
    vi.stubGlobal('fetch', fetch);
    const file = new File(['image bytes'], '洞窟.png');
    expect(await uploadInteriorMap('/map/asset', file)).toMatchObject({ name: '洞窟.png', version: 1 });
    const [, init] = fetch.mock.calls[0];
    expect(init.body).toBe(file);
    expect(init.headers['content-type']).toBe('application/octet-stream');
    expect(decodeURIComponent(init.headers['x-file-name-encoded'])).toBe(file.name);
    expect(init.headers['x-file-name']).toMatch(/^[\x20-\x7e]+$/);
  });

  it('reports upload failures so the wizard can retry rather than claiming success', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'The map could not be stored.' }), { status: 500 })));
    await expect(uploadInteriorMap('/map/asset', new File(['bytes'], 'room.png'))).rejects.toThrow('The map could not be stored.');
  });
});
