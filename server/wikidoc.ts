/** Helpers over ProseMirror JSON documents stored in wiki_pages.content. */
type PMNode = { type?: string; text?: string; attrs?: Record<string, unknown>; content?: PMNode[] };

const BLOCKS = new Set(['paragraph', 'heading', 'listItem', 'blockquote', 'codeBlock', 'tableRow']);

export function docText(node: unknown): string {
  const out: string[] = [];
  const walk = (n: PMNode) => {
    if (n.type === 'text' && n.text) out.push(n.text);
    else if (n.type === 'wikiLink') out.push(String(n.attrs?.text || n.attrs?.label || ''));
    else if (n.type === 'hardBreak') out.push('\n');
    n.content?.forEach(walk);
    if (n.type && BLOCKS.has(n.type)) out.push('\n');
  };
  if (node && typeof node === 'object') walk(node as PMNode);
  return out.join('').replace(/\n{3,}/g, '\n\n').trim();
}

export function docLinks(node: unknown): string[] {
  const ids = new Set<string>();
  const walk = (n: PMNode) => {
    if (n.type === 'wikiLink' && typeof n.attrs?.pageId === 'string') ids.add(n.attrs.pageId);
    n.content?.forEach(walk);
  };
  if (node && typeof node === 'object') walk(node as PMNode);
  return [...ids];
}
