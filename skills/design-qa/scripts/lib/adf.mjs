// Atlassian Document Format (Jira Cloud descriptions/comments) ↔ plain text.

const BLOCK_SEPARATOR = '\n\n';
// Deeper nodes (hostile or broken ticket content) are dropped instead of overflowing the stack.
const MAX_DEPTH = 100;
const INLINE_TYPES = new Set(['text', 'hardBreak', 'mention', 'emoji', 'inlineCard', 'status', 'date']);
const LIST_TYPES = new Set(['bulletList', 'orderedList', 'taskList']);

// Ticket JSON is untrusted: attrs may hold any type and content may not be an array.
const str = (v) => (v === null || v === undefined ? '' : typeof v === 'object' ? '' : String(v));
const kids = (node) => (Array.isArray(node?.content) ? node.content : []);
const isNode = (node) => node !== null && typeof node === 'object';

function inlineText(node, depth) {
  if (!isNode(node) || depth > MAX_DEPTH) return '';
  const attrs = isNode(node.attrs) ? node.attrs : {};
  switch (node.type) {
    case 'text': {
      const text = str(node.text);
      const link = (Array.isArray(node.marks) ? node.marks : []).find((m) => m?.type === 'link' && m.attrs?.href);
      const href = link ? str(link.attrs.href) : '';
      if (href && href !== text) return `${text} (${href})`;
      return text;
    }
    case 'hardBreak':
      return '\n';
    case 'mention': {
      const t = str(attrs.text ?? attrs.id);
      return t.startsWith('@') ? t : `@${t}`;
    }
    case 'emoji':
      return str(attrs.text ?? attrs.shortName);
    case 'inlineCard':
      return str(attrs.url);
    case 'status':
      return str(attrs.text);
    case 'date': {
      // ADF stores a free-form timestamp: out-of-range values are dropped, never thrown.
      const date = new Date(Number(attrs.timestamp));
      return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10);
    }
    case 'placeholder':
      return '';
    default:
      return Array.isArray(node.content) ? node.content.map((n) => inlineText(n, depth + 1)).join('') : str(node.text);
  }
}

const inlineOf = (node, depth) => kids(node).map((n) => inlineText(n, depth + 1)).join('');

function indentLines(text, prefix) {
  return text
    .split('\n')
    .map((l, i) => (i === 0 ? l : `${prefix}${l}`))
    .join('\n');
}

// List items render their nested lists at column 0; the parent list indents
// every continuation line, so each nesting level adds one indent.
function listItemText(item, depth) {
  if (depth > MAX_DEPTH) return '';
  const parts = [];
  for (const child of kids(item)) {
    if (LIST_TYPES.has(child?.type)) {
      parts.push(`\n${blockText(child, depth + 1)}`);
    } else {
      parts.push(blockText(child, depth + 1));
    }
  }
  return parts.join(' ').replace(/ \n/g, '\n').trim();
}

function blockText(node, depth = 0) {
  if (!isNode(node) || depth > MAX_DEPTH) return '';
  const attrs = isNode(node.attrs) ? node.attrs : {};
  const children = kids(node);
  const next = depth + 1;
  switch (node.type) {
    case 'doc':
      return children.map((n) => blockText(n, next)).filter((t) => t !== '').join(BLOCK_SEPARATOR);
    case 'paragraph':
      return inlineOf(node, depth);
    case 'heading':
      return `## ${inlineOf(node, depth)}`;
    case 'bulletList':
      return children.map((li) => `- ${indentLines(listItemText(li, next), '  ')}`).join('\n');
    case 'orderedList': {
      const start = Number(attrs.order) || 1;
      return children.map((li, i) => `${start + i}. ${indentLines(listItemText(li, next), '   ')}`).join('\n');
    }
    case 'taskList':
      return children
        .map((item) => {
          if (item?.type === 'taskList') return indentLines(`  ${blockText(item, next)}`, '  ');
          const box = item?.attrs?.state === 'DONE' ? '[x]' : '[ ]';
          return `- ${box} ${inlineOf(item, next)}`;
        })
        .join('\n');
    case 'decisionList':
      return children.map((item) => `- ${inlineOf(item, next)}`).join('\n');
    case 'listItem':
      return listItemText(node, depth);
    case 'codeBlock': {
      const lang = str(attrs.language);
      return `\`\`\`${lang}\n${inlineOf(node, depth)}\n\`\`\``;
    }
    case 'blockquote':
      return children
        .map((n) => blockText(n, next))
        .join('\n')
        .split('\n')
        .map((l) => `> ${l}`)
        .join('\n');
    case 'rule':
      return '---';
    case 'table':
      return children
        .map((row) => kids(row).map((cell) => kids(cell).map((c) => blockText(c, depth + 3)).join(' ').replace(/\n+/g, ' ').trim()).join(' | '))
        .join('\n');
    case 'panel':
    case 'expand':
    case 'nestedExpand':
    case 'layoutSection':
    case 'layoutColumn':
    case 'bodiedExtension': {
      const title = str(attrs.title) ? `${str(attrs.title)}\n` : '';
      return title + children.map((n) => blockText(n, next)).filter(Boolean).join('\n');
    }
    case 'blockCard':
    case 'embedCard':
      return str(attrs.url);
    case 'mediaSingle':
    case 'mediaGroup':
    case 'media':
    case 'extension':
      return '';
    default:
      if (Array.isArray(node.content)) {
        const inlineOnly = children.every((c) => INLINE_TYPES.has(c?.type));
        return inlineOnly ? inlineOf(node, depth) : children.map((n) => blockText(n, next)).filter(Boolean).join('\n');
      }
      return inlineText(node, depth);
  }
}

/**
 * ADF document → plain text. Blocks are separated by a blank line, headings
 * become "## …", bullet/ordered/task lists "- " / "1. " / "- [ ] ", tables one
 * row per line with cells joined by " | ", links "text (url)", hard breaks "\n",
 * mentions "@name", code blocks fenced. Strings (wiki markup) pass through.
 */
export function adfToText(doc) {
  if (doc === null || doc === undefined) return '';
  if (typeof doc === 'string') return doc;
  return blockText(doc).replace(/\n{3,}/g, '\n\n').trim();
}

/** Plain text → ADF document, one paragraph per non-empty line. */
export function textToAdf(text) {
  const lines = String(text ?? '')
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l.trim() !== '');
  return {
    version: 1,
    type: 'doc',
    content: lines.map((line) => ({ type: 'paragraph', content: [{ type: 'text', text: line }] })),
  };
}
