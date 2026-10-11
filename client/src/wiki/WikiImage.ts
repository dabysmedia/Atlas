import { Node, mergeAttributes, type Editor } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { clientHeaders, pendingWrites } from '../api';
import { toastError } from '../components/toast';

const uploads = new PluginKey<Map<string, number>>('wiki-image-uploads');
const validSource = (src: string) => /^(https?:\/\/|\/api\/worlds\/[a-f0-9-]+\/wiki-images\/[a-f0-9-]+$)/i.test(src);

export const WikiImage = Node.create({
  name: 'image', group: 'inline', inline: true, atom: true, draggable: true,
  addAttributes() { return { src: { default: '' }, alt: { default: '' }, title: { default: null } }; },
  parseHTML() { return [{ tag: 'img[src]', getAttrs: el => validSource(el.getAttribute('src') ?? '') ? {} : false }]; },
  renderHTML({ HTMLAttributes }) { return ['img', mergeAttributes(HTMLAttributes, { src: validSource(HTMLAttributes.src) ? HTMLAttributes.src : '', class: 'wiki-image', loading: 'lazy' })]; },
  addProseMirrorPlugins() {
    return [new Plugin({
      key: uploads,
      state: {
        init: () => new Map<string, number>(),
        apply(tr, previous) {
          const positions = new Map<string, number>();
          for (const [id, pos] of previous) {
            const mapped = tr.mapping.mapResult(pos);
            if (!mapped.deleted) positions.set(id, mapped.pos);
          }
          const change = tr.getMeta(uploads) as { add?: { id: string; pos: number }[]; remove?: string } | undefined;
          for (const item of change?.add ?? []) positions.set(item.id, item.pos);
          if (change?.remove) positions.delete(change.remove);
          return positions;
        },
      },
      props: {
        decorations(state) {
          return DecorationSet.create(state.doc, [...(uploads.getState(state) ?? [])].map(([id, pos]) => Decoration.widget(pos, () => {
            const label = document.createElement('span'); label.className = 'wiki-image-uploading'; label.textContent = 'Uploading image…'; label.setAttribute('role', 'status'); return label;
          }, { key: id })));
        },
      },
    })];
  },
});

/** Uploads use mapped placeholders, so typing during an upload doesn't move the image to the wrong place. */
export async function insertWikiImages(editor: Editor, worldId: string, files: File[], busy: (delta: number) => void) {
  if (!editor.isEditable || editor.isDestroyed || !files.length) return;
  const items = files.filter(file => {
    if (/^image\/(png|jpeg|webp|gif)$/.test(file.type) && file.size <= 10 * 1024 * 1024) return true;
    toastError(new Error('Use a PNG, JPEG, WebP or GIF up to 10 MB.')); return false;
  }).map(file => ({ file, id: crypto.randomUUID() }));
  if (!items.length) return;
  const tr = editor.state.tr.deleteSelection();
  editor.view.dispatch(tr.setMeta(uploads, { add: items.map(({ id }) => ({ id, pos: tr.selection.from })) }));
  busy(items.length);
  for (const { file, id } of items) {
    try {
      const response = await pendingWrites.track(fetch(`/api/worlds/${worldId}/wiki-images`, { method: 'POST', headers: { ...clientHeaders, 'content-type': file.type }, body: file, credentials: 'same-origin' }));
      const image = await response.json();
      if (!response.ok) throw new Error(image.error ?? 'Image upload failed');
      if (editor.isDestroyed) continue;
      const pos = uploads.getState(editor.state)?.get(id);
      if (pos !== undefined && editor.isEditable) editor.view.dispatch(editor.state.tr.insert(pos, editor.schema.nodes.image.create({ src: image.src, alt: file.name === 'image.png' ? '' : file.name })).setMeta(uploads, { remove: id }));
    } catch (error) { toastError(error); }
    finally {
      if (!editor.isDestroyed) editor.view.dispatch(editor.state.tr.setMeta(uploads, { remove: id }));
      busy(-1);
    }
  }
}
