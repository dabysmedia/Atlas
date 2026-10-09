import { forwardRef, useEffect, useImperativeHandle, useState } from 'react';
import { mergeAttributes, Node, InputRule } from '@tiptap/core';
import { NodeViewWrapper, ReactNodeViewRenderer, ReactRenderer, type NodeViewProps } from '@tiptap/react';
import Suggestion, { type SuggestionProps } from '@tiptap/suggestion';
import { PluginKey } from '@tiptap/pm/state';
import { FilePlus2, FileText } from 'lucide-react';
import type { PageIndex } from '../types';
import { rankTitles } from './usePages';

/**
 * Host hooks the editor uses to reach the world's pages. Kept in a module-level
 * object so the extension (created once per editor) always sees the latest data.
 */
export const wikiHost: {
  pages: PageIndex[];
  createPage: (title: string) => Promise<PageIndex>;
  openPage: (id: string) => void;
} = { pages: [], createPage: async () => { throw new Error('not ready'); }, openPage: () => {} };

const findByTitle = (title: string) => wikiHost.pages.find((p) => p.title.toLowerCase() === title.trim().toLowerCase());

type Item = { kind: 'page'; page: PageIndex } | { kind: 'create'; title: string };

export const WikiLink = Node.create({
  name: 'wikiLink',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      pageId: { default: null, parseHTML: (el) => el.getAttribute('data-page-id') },
      label: { default: '', parseHTML: (el) => el.getAttribute('data-label') ?? el.textContent ?? '' },
      /** Wording shown instead of the page's title, e.g. "Mendoza" linking to "Casa de Mendoza". */
      text: { default: null, parseHTML: (el) => el.getAttribute('data-text') },
    };
  },
  parseHTML() { return [{ tag: 'a[data-wikilink]' }]; },
  renderHTML({ node, HTMLAttributes }) {
    return ['a', mergeAttributes(HTMLAttributes, {
      'data-wikilink': '', 'data-page-id': node.attrs.pageId, 'data-label': node.attrs.label, 'data-text': node.attrs.text, class: 'wikilink',
    }), node.attrs.text || node.attrs.label];
  },
  renderText({ node }) { return node.attrs.text ? `[[${node.attrs.label}|${node.attrs.text}]]` : `[[${node.attrs.label}]]`; },
  addNodeView() { return ReactNodeViewRenderer(WikiLinkView); },

  /** Typing [[Some Title]] converts to a link immediately (red link if the page doesn't exist yet). */
  addInputRules() {
    return [
      new InputRule({
        find: /\[\[([^[\]]+)\]\]$/,
        handler: ({ state, range, match }) => {
          const title = match[1].trim();
          if (!title) return;
          const page = findByTitle(title);
          state.tr.replaceWith(range.from, range.to, this.type.create({ pageId: page?.id ?? null, label: page?.title ?? title }));
        },
      }),
    ];
  },

  addProseMirrorPlugins() {
    return [
      Suggestion<Item, Item>({
        editor: this.editor,
        pluginKey: new PluginKey('wikiLinkSuggest'),
        char: '[[',
        allowSpaces: true,
        allowedPrefixes: null,
        items: ({ query }) => {
          const q = query.replace(/\]+$/, '');
          const hits: Item[] = rankTitles(wikiHost.pages, q, 8).map((page) => ({ kind: 'page', page }));
          if (q.trim() && !findByTitle(q)) hits.push({ kind: 'create', title: q.trim() });
          return hits;
        },
        command: ({ editor, range, props }) => {
          const title = props.kind === 'page' ? props.page.title : props.title;
          // Insert right away so typing never races page creation; a new page's id is filled in when it exists.
          editor.chain().focus()
            .insertContentAt(range, [
              { type: 'wikiLink', attrs: { pageId: props.kind === 'page' ? props.page.id : null, label: title } },
              { type: 'text', text: ' ' },
            ])
            .run();
          if (props.kind === 'create') {
            wikiHost.createPage(title).then((page) => {
              const { tr } = editor.state;
              let changed = false;
              editor.state.doc.descendants((node, pos) => {
                if (node.type.name === 'wikiLink' && !node.attrs.pageId && node.attrs.label === title) {
                  tr.setNodeMarkup(pos, undefined, { pageId: page.id, label: page.title });
                  changed = true;
                }
              });
              if (changed) editor.view.dispatch(tr);
            }).catch(() => {});
          }
        },
        render: () => {
          let renderer: ReactRenderer<SuggestHandle, SuggestProps> | null = null;
          let unmount: (() => void) | undefined;
          return {
            onStart: (props: SuggestionProps<Item, Item>) => {
              renderer = new ReactRenderer(SuggestList, { props, editor: props.editor });
              unmount = props.mount(renderer.element as HTMLElement);
            },
            onUpdate: (props: SuggestionProps<Item, Item>) => renderer?.updateProps(props),
            onKeyDown: ({ event }) => {
              if (event.key === 'Escape') { unmount?.(); unmount = undefined; return true; }
              return renderer?.ref?.onKeyDown(event) ?? false;
            },
            onExit: () => { unmount?.(); renderer?.destroy(); renderer = null; },
          };
        },
      }),
    ];
  },
});

type SuggestProps = SuggestionProps<Item, Item>;
type SuggestHandle = { onKeyDown: (e: KeyboardEvent) => boolean };

const SuggestList = forwardRef<SuggestHandle, SuggestProps>(function SuggestList({ items, command }, ref) {
  const [sel, setSel] = useState(0);
  useEffect(() => setSel(0), [items]);
  useImperativeHandle(ref, () => ({
    onKeyDown: (e) => {
      if (e.key === 'ArrowDown') { setSel((s) => (s + 1) % Math.max(1, items.length)); return true; }
      if (e.key === 'ArrowUp') { setSel((s) => (s - 1 + items.length) % Math.max(1, items.length)); return true; }
      if (e.key === 'Enter' || e.key === 'Tab') { if (items[sel]) command(items[sel]); return true; }
      return false;
    },
  }));
  if (!items.length) return <div className="suggest"><div className="faint" style={{ padding: '6px 10px' }}>Type a page title…</div></div>;
  return (
    <div className="suggest">
      {items.map((it, i) => (
        <button key={it.kind === 'page' ? it.page.id : '__new'} className={i === sel ? 'on' : ''}
          onMouseEnter={() => setSel(i)} onMouseDown={(e) => { e.preventDefault(); command(it); }}>
          {it.kind === 'page'
            ? <><FileText size={14} className="faint" /> {it.page.title} <span className="cat">{it.page.category}</span></>
            : <><FilePlus2 size={14} className="faint" /> Create &ldquo;{it.title}&rdquo;</>}
        </button>
      ))}
    </div>
  );
});

/** Shows the target page's live title, so renaming a page updates every link to it. */
function WikiLinkView({ node }: NodeViewProps) {
  const { pageId, label, text } = node.attrs as { pageId: string | null; label: string; text: string | null };
  const page = pageId ? wikiHost.pages.find((p) => p.id === pageId) : findByTitle(label);
  const [, force] = useState(0);
  useEffect(() => {
    const h = () => force((n) => n + 1);
    window.addEventListener('atlas:pages-changed', h);
    return () => window.removeEventListener('atlas:pages-changed', h);
  }, []);
  const open = async (e: React.MouseEvent) => {
    e.preventDefault();
    if (page) return wikiHost.openPage(page.id);
    const created = await wikiHost.createPage(label);
    wikiHost.openPage(created.id);
  };
  return (
    <NodeViewWrapper as="span" className={`wikilink ${page ? '' : 'missing'}`} onClick={open}
      title={page ? `Open ${page.title}` : `"${label}" doesn't exist yet. Click to create it.`} data-wikilink="">
      {text || (page?.title ?? label)}
    </NodeViewWrapper>
  );
}

/** Before saving: point red links at pages that now exist, and refresh labels. */
export function resolveLinks(doc: unknown): unknown {
  const walk = (n: Record<string, unknown>): Record<string, unknown> => {
    if (n.type === 'wikiLink') {
      const attrs = n.attrs as { pageId: string | null; label: string };
      const page = attrs.pageId ? wikiHost.pages.find((p) => p.id === attrs.pageId) : findByTitle(attrs.label);
      if (page) return { ...n, attrs: { ...attrs, pageId: page.id, label: page.title } };
      return n;
    }
    if (Array.isArray(n.content)) return { ...n, content: (n.content as Record<string, unknown>[]).map(walk) };
    return n;
  };
  return doc && typeof doc === 'object' ? walk(doc as Record<string, unknown>) : doc;
}
