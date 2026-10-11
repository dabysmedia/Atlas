import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { EditorContent, useEditor, useEditorState, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Placeholder } from '@tiptap/extensions';
import { motion } from 'motion/react';
import {
  ArrowDown, ArrowUp, Bold, Check, ChevronDown, ChevronRight, Heading2, Heading3, ImagePlus, Italic, Link2, List, ListOrdered, MoreHorizontal, Pencil, Plus, Quote, Search, Strikethrough, Trash2,
} from 'lucide-react';
import { api, qk } from '../api';
import { canonical } from '../live';
import type { Page, PageIndex } from '../types';
import { useWorld } from '../world';
import { lastPage } from '../prefs';
import { Snippet, useCombinedSearch, useCreatePage, usePageIndex } from './usePages';
import { resolveLinks, WikiLink, wikiHost } from './WikiLink';
import { Dialog } from '../components/Dialog';
import { toastError } from '../components/toast';
import { insertWikiImages, WikiImage } from './WikiImage';

export const CATEGORIES = ['Lore', 'Place', 'Person', 'Faction', 'Item', 'Session', 'Rules'];

export function WikiView() {
  const world = useWorld();
  const { pageId } = useParams();
  const navigate = useNavigate();
  const index = usePageIndex(world.id);
  const create = useCreatePage(world.id);
  const [filter, setFilter] = useState('');
  const [editing, setEditing] = useState(false);
  const results = useCombinedSearch(world.id, filter);
  const qc = useQueryClient();
  const article = useRef<HTMLElement>(null);
  useEffect(() => { article.current?.scrollTo({ top: 0 }); }, [pageId]);

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

  const newPage = async (parent?: PageIndex) => {
    try {
      let title = 'Untitled page', n = 1;
      const taken = new Set((index.data ?? []).map((p) => p.title.toLowerCase()));
      while (taken.has(title.toLowerCase())) title = `Untitled page ${++n}`;
      const page = await create.mutateAsync({ title, parentId: parent?.id ?? null, category: parent?.category });
      qc.setQueryData(qk.page(world.id, page.id), { ...page, content: { type: 'doc', content: [{ type: 'paragraph' }] }, contentText: '', backlinks: [], _fresh: true });
      navigate(`/w/${world.id}/wiki/${page.id}`, { state: { focusTitle: true } });
      setEditing(true);
    } catch (e) { toastError(e); }
  };

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
            {editing && <button className="btn primary icon" onClick={() => void newPage()} aria-label="New page"><Plus size={16} /></button>}
            {!pageId && <button className="iconbtn" onClick={() => setEditing(v => !v)} aria-label={editing ? 'Finish editing wiki' : 'Edit wiki'} aria-pressed={editing}><Pencil size={15} /></button>}
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
          ) : <WikiTree pages={index.data ?? []} selected={pageId} editing={editing} onNew={newPage} />}
          {index.data && !index.data.length && <div className="empty">No pages yet.<br />{editing ? <>Press <b>+</b> to write the first one.</> : <>Enable Edit to write the first one.</>}</div>}
        </div>
      </aside>
      <section ref={article} className="wiki-main scroll">
        {pageId ? <PageEditor key={pageId} pageId={pageId} editing={editing} onEditing={setEditing} /> : <WikiHome onNew={() => void newPage()} editing={editing} onEditing={setEditing} />}
      </section>
    </div>
  );
}

function WikiHome({ onNew, editing, onEditing }: { onNew: () => void; editing: boolean; onEditing: (v: boolean) => void }) {
  const world = useWorld();
  const index = usePageIndex(world.id);
  const navigate = useNavigate();
  const recent = (index.data ?? []).slice(0, 8);
  return (
    <div className="wiki-doc">
      <h1 className="wiki-title">{world.name} Wiki</h1>
      <p className="muted">Type <span className="kbd">[[</span> in any page to link another page, or to create one on the spot. <span className="kbd">Ctrl K</span> finds anything.</p>
      {editing ? <button className="btn primary" onClick={onNew} style={{ marginTop: 10 }}><Plus size={15} /> New page</button>
        : <button className="btn ghost" onClick={() => onEditing(true)} style={{ marginTop: 10 }}><Pencil size={15} /> Edit wiki</button>}
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

const pageOrder = (a: PageIndex, b: PageIndex) => a.sortOrder - b.sortOrder || a.title.localeCompare(b.title);
function WikiTree({ pages, selected, editing, onNew }: { pages: PageIndex[]; selected?: string; editing: boolean; onNew: (p: PageIndex) => Promise<void> }) {
  const world = useWorld(), navigate = useNavigate(), qc = useQueryClient();
  const [collapsed, setCollapsed] = useState(new Set<string>());
  const [organize, setOrganize] = useState<string | null>(null);
  const [parent, setParent] = useState('');
  const [drop, setDrop] = useState<string | null>(null);
  const byId = useMemo(() => new Map(pages.map(p => [p.id, p])), [pages]);
  const current = organize ? byId.get(organize) : undefined;
  const within = (p: PageIndex, ancestor: string) => {
    const seen = new Set<string>();
    let id: string | null = p.id;
    while (id && !seen.has(id)) { if (id === ancestor) return true; seen.add(id); id = byId.get(id)?.parentId ?? null; }
    return false;
  };
  // Keep the selected page's ancestors open, including after a drag or a search jump.
  useEffect(() => {
    if (!selected) return;
    setCollapsed(previous => { const next = new Set(previous); let p = byId.get(selected); const seen = new Set<string>();
      while (p?.parentId && !seen.has(p.parentId)) { seen.add(p.parentId); next.delete(p.parentId); p = byId.get(p.parentId); }
      return next;
    });
  }, [selected, byId]);
  useEffect(() => { if (!editing) setOrganize(null); }, [editing]);
  const changed = async () => {
    await qc.invalidateQueries({ queryKey: qk.pages(world.id) });
    await qc.invalidateQueries({ predicate: q => q.queryKey[0] === 'w' && q.queryKey[1] === world.id && q.queryKey[2] === 'page' });
  };
  const move = useMutation({ mutationFn: ({ id, parentId }: { id: string; parentId: string | null }) => api(`/api/worlds/${world.id}/pages/${id}`, { method: 'PATCH', body: { parentId } }), onSuccess: changed, onError: toastError });
  const reorder = useMutation({ mutationFn: (ids: string[]) => api(`/api/worlds/${world.id}/pages/reorder`, { body: { parentId: current?.parentId ?? null, ids } }), onSuccess: changed, onError: toastError });
  const siblings = current ? pages.filter(p => p.parentId === current.parentId).sort(pageOrder) : [];
  const visibleSiblings = siblings.filter(p => current?.parentId || p.category === current?.category);
  const place = current ? visibleSiblings.findIndex(p => p.id === current.id) : -1;
  const step = (offset: number) => {
    const neighbor = visibleSiblings[place + offset];
    if (!current || !neighbor) return;
    const ids = siblings.map(p => p.id), from = ids.indexOf(current.id), to = ids.indexOf(neighbor.id);
    [ids[from], ids[to]] = [ids[to], ids[from]]; reorder.mutate(ids);
  };
  const toggle = (id: string) => setCollapsed(old => { const next = new Set(old); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const branch = (p: PageIndex, depth: number): React.ReactNode => {
    const children = pages.filter(c => c.parentId === p.id).sort(pageOrder), shut = collapsed.has(p.id);
    return <div key={p.id}>
      <div className={`wiki-item wiki-tree-item ${p.id === selected ? 'on' : ''} ${drop === p.id ? 'drop-target' : ''}`} role="treeitem" aria-level={depth + 1}
        aria-selected={p.id === selected} aria-expanded={children.length ? !shut : undefined} tabIndex={0} style={{ paddingLeft: 6 + depth * 14 }}
        draggable={editing} onDragStart={e => { e.dataTransfer.setData('application/x-atlas-page', p.id); e.dataTransfer.effectAllowed = 'move'; }}
        onDragOver={e => { if (editing && e.dataTransfer.types.includes('application/x-atlas-page')) { e.preventDefault(); setDrop(p.id); } }}
        onDragLeave={() => setDrop(null)} onDrop={e => { e.preventDefault(); setDrop(null); const id = e.dataTransfer.getData('application/x-atlas-page'); if (editing && id && id !== p.id) move.mutate({ id, parentId: p.id }); }}
        onClick={() => navigate(`/w/${world.id}/wiki/${p.id}`)} onKeyDown={e => {
          if (e.target !== e.currentTarget) return;
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigate(`/w/${world.id}/wiki/${p.id}`); }
          if (children.length && (e.key === 'ArrowRight' && shut || e.key === 'ArrowLeft' && !shut)) { e.preventDefault(); toggle(p.id); }
        }}>
        {children.length ? <button className="wiki-tree-control" aria-label={`${shut ? 'Expand' : 'Collapse'} ${p.title}`} onClick={e => { e.stopPropagation(); toggle(p.id); }}>{shut ? <ChevronRight size={13} /> : <ChevronDown size={13} />}</button> : <span className="wiki-tree-spacer" />}
        <span className="t grow" title={p.title}>{p.title}</span>
        {editing && <span className="wiki-tree-actions">
          <button className="wiki-tree-control" aria-label={`New child of ${p.title}`} onClick={e => { e.stopPropagation(); void onNew(p); }}><Plus size={13} /></button>
          <button className="wiki-tree-control" aria-label={`Organize ${p.title}`} onClick={e => { e.stopPropagation(); setOrganize(p.id); setParent(p.parentId ?? ''); }}><MoreHorizontal size={13} /></button>
        </span>}
      </div>
      {!!children.length && !shut && <div role="group">{children.map(c => branch(c, depth + 1))}</div>}
    </div>;
  };
  const roots = pages.filter(p => !p.parentId || !byId.has(p.parentId));
  const categories = [...new Set(roots.map(p => p.category))].sort();
  return <>
    <div role="tree" aria-label="Wiki pages">
      {categories.map(category => <div key={category}>
        <div className="wiki-group">{category}</div>
        {roots.filter(p => p.category === category).sort(pageOrder).map(p => branch(p, 0))}
      </div>)}
    </div>
    <Dialog open={!!current} onClose={() => setOrganize(null)} title="Organize page">
      {current && <>
        <p className="muted" style={{ marginTop: 0 }}>{current.title}</p>
        <label className="field">Parent page<select className="select" aria-label="Parent page" value={parent} onChange={e => setParent(e.target.value)}>
          <option value="">Top level</option>
          {pages.filter(p => !within(p, current.id)).sort((a, b) => a.title.localeCompare(b.title)).map(p => <option key={p.id} value={p.id}>{p.title}</option>)}
        </select></label>
        <div className="row" style={{ marginTop: 16 }}>
          <button className="btn sm" disabled={place <= 0 || reorder.isPending} onClick={() => step(-1)}><ArrowUp size={13} /> Move up</button>
          <button className="btn sm" disabled={place < 0 || place >= visibleSiblings.length - 1 || reorder.isPending} onClick={() => step(1)}><ArrowDown size={13} /> Move down</button>
        </div>
        <p className="faint">Drag a page onto another page to nest it. Moving a parent keeps its children together.</p>
        <div className="actions"><button className="btn ghost" onClick={() => setOrganize(null)}>Cancel</button>
          <button className="btn primary" disabled={move.isPending} onClick={async () => { try { await move.mutateAsync({ id: current.id, parentId: parent || null }); setOrganize(null); } catch { /* mutation shows the error */ } }}>Save parent</button>
        </div>
      </>}
    </Dialog>
  </>;
}

function PageEditor({ pageId, editing, onEditing }: { pageId: string; editing: boolean; onEditing: (v: boolean) => void }) {
  const world = useWorld();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const page = useQuery({ queryKey: qk.page(world.id, pageId), queryFn: () => api<Page>(`/api/worlds/${world.id}/pages/${pageId}`) });
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState('Lore');
  const [save, setSave] = useState<SaveState>('saved');
  const [titleError, setTitleError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [uploading, setUploading] = useState(0);
  const imageInput = useRef<HTMLInputElement>(null);
  const deleting = useRef(false);
  const pending = useRef<{ title?: string; category?: string; content?: unknown }>({});
  const timer = useRef<number | undefined>(undefined);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const loaded = useRef(false);
  const saving = useRef(false);
  /** The stored page as this editor last took it in (or saved it), to tell another screen's edit from its own. */
  const shown = useRef({ title: '', category: '', content: '' });

  const flush = async () => {
    window.clearTimeout(timer.current);
    if (deleting.current) return;
    const body = pending.current;
    if (!Object.keys(body).length) return;
    pending.current = {};
    setSave('saving');
    saving.current = true;
    try {
      if (body.content) body.content = resolveLinks(body.content);
      const row = await api<PageIndex>(`/api/worlds/${world.id}/pages/${pageId}`, { method: 'PATCH', body });
      if (deleting.current) return;
      // Only what this save sent counts as taken in: another screen's rename that arrived meanwhile still has to show.
      shown.current = {
        title: body.title !== undefined ? row.title : shown.current.title,
        category: body.category !== undefined ? row.category : shown.current.category,
        content: body.content ? canonical(body.content) : shown.current.content,
      };
      setTitleError('');
      qc.setQueryData<PageIndex[]>(qk.pages(world.id), (xs) => [row, ...(xs ?? []).filter((x) => x.id !== row.id)]);
      qc.setQueryData<Page>(qk.page(world.id, pageId), (p) => (p ? { ...p, ...row, ...(body.content ? { content: body.content } : {}) } : p));
      // Backlinks on other pages may have changed.
      qc.invalidateQueries({ predicate: (q) => q.queryKey[2] === 'page' && q.queryKey[3] !== pageId });
      qc.invalidateQueries({ queryKey: ['w', world.id, 'search'] });
      setSave(Object.keys(pending.current).length ? 'dirty' : 'saved');
    } catch (e) {
      if (deleting.current) return;
      const msg = e instanceof Error ? e.message : 'Save failed';
      if (body.title && /title/.test(msg)) { setTitleError(msg); setSave('saved'); }
      else { pending.current = { ...body, ...pending.current }; setSave('error'); toastError(e); }
    } finally { saving.current = false; }
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

  const editor: Editor | null = useEditor({
    extensions: [
      StarterKit.configure({ link: { openOnClick: false, autolink: true }, heading: { levels: [1, 2, 3] } }),
      Placeholder.configure({ placeholder: 'Write lore… Type [[ to link a page.' }),
      WikiLink,
      WikiImage,
    ],
    content: null,
    editable: false,
    editorProps: {
      handlePaste: (_view, event) => {
        if (!editor?.isEditable) return false;
        const files = [...(event.clipboardData?.files ?? [])].filter(file => file.type.startsWith('image/'));
        if (!files.length) return false;
        event.preventDefault(); void insertWikiImages(editor, world.id, files, delta => setUploading(n => n + delta)); return true;
      },
    },
    immediatelyRender: true,
    shouldRerenderOnTransaction: false,
    onUpdate: ({ editor }) => { if (loaded.current && editor.isEditable) queue({ content: editor.getJSON() }); },
  });
  useEffect(() => { editor?.setEditable(editing && !!page.data); }, [editing, editor, !!page.data]);

  useEffect(() => {
    if (!page.data || !editor || loaded.current) return;
    editor.commands.setContent(page.data.content as object, { emitUpdate: false });
    setTitle(page.data.title);
    setCategory(page.data.category);
    shown.current = { title: page.data.title, category: page.data.category, content: canonical(page.data.content) };
    loaded.current = true;
    const fresh = (page.data as { _fresh?: boolean })._fresh;
    // A brand-new page: select the placeholder title so typing replaces it.
    if (fresh) {
      onEditing(true);
      qc.setQueryData(qk.page(world.id, pageId), { ...page.data, _fresh: false });
      requestAnimationFrame(() => { titleRef.current?.focus(); titleRef.current?.select(); });
    }
  }, [page.data, editor]);

  // Another screen saved this page: take its version in, unless this one has typing of its own still to save
  // (its save then wins). The cursor stays where it was, as near as the new text allows.
  useEffect(() => {
    const p = page.data;
    if (!p || !editor || !loaded.current || saving.current || Object.keys(pending.current).length) return;
    if (p.title !== shown.current.title) setTitle(p.title);
    if (p.category !== shown.current.category) setCategory(p.category);
    const content = canonical(p.content);
    if (content !== shown.current.content) {
      const { from, to } = editor.state.selection;
      editor.commands.setContent(p.content as object, { emitUpdate: false });
      const end = editor.state.doc.content.size;
      editor.commands.setTextSelection({ from: Math.min(from, end), to: Math.min(to, end) });
    }
    shown.current = { title: p.title, category: p.category, content };
  }, [page.data, editor]);

  useEffect(() => {
    const el = titleRef.current;
    if (el) { el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px`; }
  }, [title]);

  const del = useMutation({
    mutationFn: () => {
      window.clearTimeout(timer.current); pending.current = {}; deleting.current = true;
      return api(`/api/worlds/${world.id}/pages/${pageId}`, { method: 'DELETE' });
    },
    onSuccess: () => {
      pending.current = {};
      qc.setQueryData<PageIndex[]>(qk.pages(world.id), (xs) => (xs ?? []).filter((x) => x.id !== pageId));
      qc.removeQueries({ queryKey: qk.page(world.id, pageId) });
      qc.invalidateQueries({ queryKey: qk.pages(world.id) });
      navigate(`/w/${world.id}/wiki`);
    },
    onError: (e) => { deleting.current = false; toastError(e); },
  });

  if (page.isError) return <div className="empty">This page doesn&rsquo;t exist (it may have been deleted).</div>;
  return (
    <motion.div className="wiki-doc" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.18 }}>
      <textarea ref={titleRef} className="wiki-title" rows={1} value={title} readOnly={!editing || !page.data} placeholder="Page title" aria-label="Page title"
        onChange={(e) => { const v = e.target.value.replace(/\n/g, ''); setTitle(v); if (v.trim()) queue({ title: v.trim() }); }}
        onKeyDown={(e) => {
          if (editing && (e.key === 'Enter' || e.key === 'ArrowDown')) {
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
        <button className={`wiki-edit ${editing ? 'on' : ''}`} aria-label={editing ? 'Finish editing page' : 'Edit page'} aria-pressed={editing} disabled={uploading > 0 || !page.data}
          onClick={() => { if (editing) void flush(); onEditing(!editing); }}>
          {editing ? <Check size={13} /> : <Pencil size={13} />}{editing ? 'Done' : 'Edit'}
        </button>
        <span>·</span>
        {editing ? <input className="input bare" list="wiki-cats" style={{ width: 120, padding: '0 4px', fontSize: 12, color: 'var(--text-dim)' }}
          value={category} onChange={(e) => { setCategory(e.target.value); queue({ category: e.target.value }); }} aria-label="Category" />
          : <span>{category}</span>}
        <datalist id="wiki-cats">{CATEGORIES.map((c) => <option key={c} value={c} />)}</datalist>
        <div className="spacer" />
        {editing && <button className="btn ghost sm danger" disabled={uploading > 0} onClick={() => setConfirmDelete(true)}><Trash2 size={13} /> Delete</button>}
      </div>
      {editor && editing && <FormatBar editor={editor} onImage={() => imageInput.current?.click()} />}
      <input ref={imageInput} type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden onChange={e => {
        const files = [...(e.target.files ?? [])]; e.target.value = '';
        if (editor) void insertWikiImages(editor, world.id, files, delta => setUploading(n => n + delta));
      }} />
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
        <p className="muted" style={{ marginTop: 0 }}>Delete &ldquo;{title}&rdquo;? Links to it will turn red. Its child pages will move up one level.</p>
        <div className="actions">
          <button className="btn ghost" disabled={del.isPending} onClick={() => setConfirmDelete(false)}>Cancel</button>
          <button className="btn danger" disabled={del.isPending} onClick={() => del.mutate()}><Trash2 size={14} /> {del.isPending ? 'Deleting…' : 'Delete'}</button>
        </div>
      </Dialog>
    </motion.div>
  );
}

function FormatBar({ editor, onImage }: { editor: Editor; onImage: () => void }) {
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive('bold'), italic: e.isActive('italic'), strike: e.isActive('strike'),
      h2: e.isActive('heading', { level: 2 }), h3: e.isActive('heading', { level: 3 }),
      ul: e.isActive('bulletList'), ol: e.isActive('orderedList'), quote: e.isActive('blockquote'),
    }),
  });
  const b = (on: boolean, label: string, run: () => void, Icon: typeof Bold) => (
    <button className={on ? 'on' : ''} title={label} aria-label={label} onMouseDown={e => e.preventDefault()} onClick={run}><Icon size={15} /></button>
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
      {b(false, 'Insert image', onImage, ImagePlus)}
    </div>
  );
}
