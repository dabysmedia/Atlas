import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { EditorContent, useEditor, useEditorState, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Placeholder } from '@tiptap/extensions';
import { motion } from 'motion/react';
import {
  Bold, Heading2, Heading3, Italic, Link2, List, ListOrdered, Plus, Quote, Search, Strikethrough, Trash2,
} from 'lucide-react';
import { api, qk } from '../api';
import type { Page, PageIndex } from '../types';
import { useWorld } from '../world';
import { lastPage } from '../prefs';
import { Snippet, useCombinedSearch, useCreatePage, usePageIndex } from './usePages';
import { resolveLinks, WikiLink, wikiHost } from './WikiLink';
import { Dialog } from '../components/Dialog';
import { toastError } from '../components/toast';

export const CATEGORIES = ['Lore', 'Place', 'Person', 'Faction', 'Item', 'Session', 'Rules'];

export function WikiView() {
  const world = useWorld();
  const { pageId } = useParams();
  const navigate = useNavigate();
  const index = usePageIndex(world.id);
  const create = useCreatePage(world.id);
  const [filter, setFilter] = useState('');
  const results = useCombinedSearch(world.id, filter);
  const qc = useQueryClient();

  // Keep the editor's link machinery pointed at this world's pages.
  useEffect(() => {
    wikiHost.pages = index.data ?? [];
    wikiHost.createPage = (title) => create.mutateAsync({ title });
    wikiHost.openPage = (id) => navigate(`/w/${world.id}/wiki/${id}`);
    window.dispatchEvent(new Event('atlas:pages-changed'));
  }, [index.data, create, navigate, world.id]);

  // Reopen the last page when arriving at the bare wiki route.
  useEffect(() => {
    if (pageId || !index.data?.length) return;
    const last = lastPage(world.id).get();
    if (last && index.data.some((p) => p.id === last)) navigate(`/w/${world.id}/wiki/${last}`, { replace: true });
  }, [pageId, index.data, world.id, navigate]);
  useEffect(() => { if (pageId) lastPage(world.id).set(pageId); }, [pageId, world.id]);

  const newPage = async () => {
    try {
      let title = 'Untitled page', n = 1;
      const taken = new Set((index.data ?? []).map((p) => p.title.toLowerCase()));
      while (taken.has(title.toLowerCase())) title = `Untitled page ${++n}`;
      const page = await create.mutateAsync({ title });
      qc.setQueryData(qk.page(world.id, page.id), { ...page, content: { type: 'doc', content: [{ type: 'paragraph' }] }, contentText: '', backlinks: [], _fresh: true });
      navigate(`/w/${world.id}/wiki/${page.id}`, { state: { focusTitle: true } });
    } catch (e) { toastError(e); }
  };

  const grouped = useMemo(() => {
    const m = new Map<string, PageIndex[]>();
    for (const p of [...(index.data ?? [])].sort((a, b) => a.title.localeCompare(b.title))) {
      if (!m.has(p.category)) m.set(p.category, []);
      m.get(p.category)!.push(p);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [index.data]);

  return (
    <div className="wiki">
      <aside className="wiki-side">
        <div className="head">
          <div className="row">
            <div className="row grow" style={{ position: 'relative' }}>
              <Search size={14} className="faint" style={{ position: 'absolute', left: 9 }} />
              <input className="input" style={{ paddingLeft: 28 }} placeholder="Search pages" value={filter}
                onChange={(e) => setFilter(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && results[0]) { navigate(`/w/${world.id}/wiki/${results[0].id}`); }
                  if (e.key === 'Escape') setFilter('');
                }} />
            </div>
            <button className="btn primary icon" onClick={newPage} title="New page"><Plus size={16} /></button>
          </div>
        </div>
        <div className="wiki-list scroll">
          {filter.trim() ? (
            results.length ? results.map((r) => (
              <div key={r.id} className={`wiki-item ${r.id === pageId ? 'on' : ''}`} onClick={() => navigate(`/w/${world.id}/wiki/${r.id}`)}>
                <div className="grow">
                  <span className="t">{r.title}</span>
                  {r.snippet && <span className="snip"><Snippet text={r.snippet} /></span>}
                </div>
              </div>
            )) : <div className="empty">No matches.</div>
          ) : grouped.map(([cat, pages]) => (
            <div key={cat}>
              <div className="wiki-group">{cat} <span style={{ opacity: 0.6 }}>{pages.length}</span></div>
              {pages.map((p) => (
                <div key={p.id} className={`wiki-item ${p.id === pageId ? 'on' : ''}`} onClick={() => navigate(`/w/${world.id}/wiki/${p.id}`)}>
                  <span className="t">{p.title}</span>
                </div>
              ))}
            </div>
          ))}
          {index.data && !index.data.length && <div className="empty">No pages yet.<br />Press <b>+</b> to write the first one.</div>}
        </div>
      </aside>
      <section className="wiki-main scroll">
        {pageId ? <PageEditor key={pageId} pageId={pageId} /> : <WikiHome onNew={newPage} />}
      </section>
    </div>
  );
}

function WikiHome({ onNew }: { onNew: () => void }) {
  const world = useWorld();
  const index = usePageIndex(world.id);
  const navigate = useNavigate();
  const recent = (index.data ?? []).slice(0, 8);
  return (
    <div className="wiki-doc">
      <h1 className="wiki-title">{world.name} Wiki</h1>
      <p className="muted">Type <span className="kbd">[[</span> in any page to link another page, or to create one on the spot. <span className="kbd">Ctrl K</span> finds anything.</p>
      <button className="btn primary" onClick={onNew} style={{ marginTop: 10 }}><Plus size={15} /> New page</button>
      {!!recent.length && (
        <>
          <div className="label" style={{ marginTop: 32 }}>Recently edited</div>
          {recent.map((p) => (
            <div key={p.id} className="wiki-item" onClick={() => navigate(`/w/${world.id}/wiki/${p.id}`)}>
              <span className="t grow">{p.title}</span><span className="faint" style={{ fontSize: 12 }}>{p.category}</span>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

type SaveState = 'saved' | 'dirty' | 'saving' | 'error';

function PageEditor({ pageId }: { pageId: string }) {
  const world = useWorld();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const page = useQuery({ queryKey: qk.page(world.id, pageId), queryFn: () => api<Page>(`/api/worlds/${world.id}/pages/${pageId}`) });
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState('Lore');
  const [save, setSave] = useState<SaveState>('saved');
  const [titleError, setTitleError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const pending = useRef<{ title?: string; category?: string; content?: unknown }>({});
  const timer = useRef<number | undefined>(undefined);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const loaded = useRef(false);

  const flush = async () => {
    window.clearTimeout(timer.current);
    const body = pending.current;
    if (!Object.keys(body).length) return;
    pending.current = {};
    setSave('saving');
    try {
      if (body.content) body.content = resolveLinks(body.content);
      const row = await api<PageIndex>(`/api/worlds/${world.id}/pages/${pageId}`, { method: 'PATCH', body });
      setTitleError('');
      qc.setQueryData<PageIndex[]>(qk.pages(world.id), (xs) => [row, ...(xs ?? []).filter((x) => x.id !== row.id)]);
      qc.setQueryData<Page>(qk.page(world.id, pageId), (p) => (p ? { ...p, ...row, ...(body.content ? { content: body.content } : {}) } : p));
      // Backlinks on other pages may have changed.
      qc.invalidateQueries({ predicate: (q) => q.queryKey[2] === 'page' && q.queryKey[3] !== pageId });
      qc.invalidateQueries({ queryKey: ['w', world.id, 'search'] });
      setSave(Object.keys(pending.current).length ? 'dirty' : 'saved');
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Save failed';
      if (body.title && /title/.test(msg)) { setTitleError(msg); setSave('saved'); }
      else { pending.current = { ...body, ...pending.current }; setSave('error'); toastError(e); }
    }
  };
  const queue = (patch: typeof pending.current) => {
    pending.current = { ...pending.current, ...patch };
    setSave('dirty');
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(flush, 700);
  };
  // Save on leave.
  useEffect(() => () => { void flush(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const before = () => { void flush(); };
    window.addEventListener('beforeunload', before);
    return () => window.removeEventListener('beforeunload', before);
  });

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ link: { openOnClick: false, autolink: true }, heading: { levels: [1, 2, 3] } }),
      Placeholder.configure({ placeholder: 'Write lore… Type [[ to link a page.' }),
      WikiLink,
    ],
    content: null,
    immediatelyRender: true,
    shouldRerenderOnTransaction: false,
    onUpdate: ({ editor }) => { if (loaded.current) queue({ content: editor.getJSON() }); },
  });

  useEffect(() => {
    if (!page.data || !editor || loaded.current) return;
    editor.commands.setContent(page.data.content as object, { emitUpdate: false });
    setTitle(page.data.title);
    setCategory(page.data.category);
    loaded.current = true;
    const fresh = (page.data as { _fresh?: boolean })._fresh;
    // A brand-new page: select the placeholder title so typing replaces it.
    if (fresh) requestAnimationFrame(() => { titleRef.current?.focus(); titleRef.current?.select(); });
  }, [page.data, editor]);

  useEffect(() => {
    const el = titleRef.current;
    if (el) { el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px`; }
  }, [title]);

  const del = useMutation({
    mutationFn: () => api(`/api/worlds/${world.id}/pages/${pageId}`, { method: 'DELETE' }),
    onSuccess: () => {
      pending.current = {};
      qc.setQueryData<PageIndex[]>(qk.pages(world.id), (xs) => (xs ?? []).filter((x) => x.id !== pageId));
      qc.removeQueries({ queryKey: qk.page(world.id, pageId) });
      navigate(`/w/${world.id}/wiki`);
    },
    onError: toastError,
  });

  if (page.isError) return <div className="empty">This page doesn&rsquo;t exist (it may have been deleted).</div>;
  return (
    <motion.div className="wiki-doc" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.18 }}>
      <textarea ref={titleRef} className="wiki-title" rows={1} value={title} placeholder="Page title" aria-label="Page title"
        onChange={(e) => { const v = e.target.value.replace(/\n/g, ''); setTitle(v); if (v.trim()) queue({ title: v.trim() }); }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === 'ArrowDown') {
            e.preventDefault();
            // Focus synchronously so the next keystroke lands in the body, not the title.
            if (editor) { editor.commands.setTextSelection(1); editor.view.focus(); }
          }
        }}
        style={{ resize: 'none', overflow: 'hidden' }} />
      {titleError && <div className="error-text">{titleError}</div>}
      <div className="wiki-meta">
        <span className={`save-dot ${save === 'dirty' || save === 'saving' ? 'dirty' : save === 'error' ? 'err' : ''}`} />
        <span>{save === 'saved' ? 'Saved' : save === 'error' ? 'Not saved, retrying on next edit' : 'Saving…'}</span>
        <span>·</span>
        <input className="input bare" list="wiki-cats" style={{ width: 120, padding: '0 4px', fontSize: 12, color: 'var(--text-dim)' }}
          value={category} onChange={(e) => { setCategory(e.target.value); queue({ category: e.target.value }); }} aria-label="Category" />
        <datalist id="wiki-cats">{CATEGORIES.map((c) => <option key={c} value={c} />)}</datalist>
        <div className="spacer" />
        <button className="btn ghost sm danger" onClick={() => setConfirmDelete(true)}><Trash2 size={13} /> Delete</button>
      </div>
      {editor && <FormatBar editor={editor} />}
      <EditorContent editor={editor} />
      {!!page.data?.backlinks.length && (
        <div className="backlinks">
          <div className="label">Linked from</div>
          <div className="chips">
            {page.data.backlinks.map((b) => (
              <button key={b.id} className="chip" style={{ cursor: 'pointer' }} onClick={() => navigate(`/w/${world.id}/wiki/${b.id}`)}>{b.title}</button>
            ))}
          </div>
        </div>
      )}
      <Dialog open={confirmDelete} onClose={() => setConfirmDelete(false)} title="Delete page">
        <p className="muted" style={{ marginTop: 0 }}>Delete &ldquo;{title}&rdquo;? Links to it will turn red (clicking one recreates the page).</p>
        <div className="actions">
          <button className="btn ghost" onClick={() => setConfirmDelete(false)}>Cancel</button>
          <button className="btn danger" onClick={() => { setConfirmDelete(false); del.mutate(); }}><Trash2 size={14} /> Delete</button>
        </div>
      </Dialog>
    </motion.div>
  );
}

function FormatBar({ editor }: { editor: Editor }) {
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive('bold'), italic: e.isActive('italic'), strike: e.isActive('strike'),
      h2: e.isActive('heading', { level: 2 }), h3: e.isActive('heading', { level: 3 }),
      ul: e.isActive('bulletList'), ol: e.isActive('orderedList'), quote: e.isActive('blockquote'),
    }),
  });
  const b = (on: boolean, label: string, run: () => void, Icon: typeof Bold) => (
    <button className={on ? 'on' : ''} title={label} aria-label={label} onMouseDown={(e) => { e.preventDefault(); run(); }}><Icon size={15} /></button>
  );
  const c = () => editor.chain().focus();
  return (
    <div className="toolbar-float" style={{ position: 'sticky', top: 8, zIndex: 3, width: 'fit-content', marginBottom: 18, boxShadow: 'none' }}>
      {b(s.h2, 'Heading', () => c().toggleHeading({ level: 2 }).run(), Heading2)}
      {b(s.h3, 'Subheading', () => c().toggleHeading({ level: 3 }).run(), Heading3)}
      {b(s.bold, 'Bold (Ctrl+B)', () => c().toggleBold().run(), Bold)}
      {b(s.italic, 'Italic (Ctrl+I)', () => c().toggleItalic().run(), Italic)}
      {b(s.strike, 'Strikethrough', () => c().toggleStrike().run(), Strikethrough)}
      {b(s.ul, 'Bullet list', () => c().toggleBulletList().run(), List)}
      {b(s.ol, 'Numbered list', () => c().toggleOrderedList().run(), ListOrdered)}
      {b(s.quote, 'Quote', () => c().toggleBlockquote().run(), Quote)}
      {b(false, 'Link a page ([[)', () => c().insertContent('[[').run(), Link2)}
    </div>
  );
}
