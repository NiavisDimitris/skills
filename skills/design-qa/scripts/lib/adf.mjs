// Atlassian Document Format (Jira Cloud descriptions/comments) ↔ plain text.

const BLOCK_SEPARATOR = '\n\n';

function inlineText(node) {
  if (!node || typeof node !== 'object') return '';
  switch (node.type) {
    case 'text': {
      const text = node.text ?? '';
      const link = (node.marks || []).find((m) => m?.type === 'link' && m.attrs?.href);
      if (link && link.attrs.href !== text) return `${text} (${link.attrs.href})`;
      return text;
    }
    case 'hardBreak':
      return '\n';
    case 'mention': {
      const t = node.attrs?.text ?? node.attrs?.id ?? '';
      return t.startsWith('@') ? t : `@${t}`;
    }
    case 'emoji':
      return node.attrs?.text ?? node.attrs?.shortName ?? '';
    case 'inlineCard':
      return node.attrs?.url ?? '';
    case 'status':
      return node.attrs?.text ?? '';
    case 'date': {
      const ts = Number(node.attrs?.timestamp);
      return Number.isFinite(ts) ? new Date(ts).toISOString().slice(0, 10) : '';
    }
    case 'placeholder':
      return '';
    default:
      return Array.isArray(node.content) ? node.content.map(inlineText).join('') : node.text ?? '';
  }
}

function indentLines(text, prefix) {
  return text
    .split('\n')
    .map((l, i) => (i === 0 ? l : `${prefix}${l}`))
    .join('\n');
}

// List items render their nested lists at column 0; the parent list indents
// every continuation line, so each nesting level adds one indent.
function listItemText(item) {
  const parts = [];
  for (const child of item?.content || []) {
    if (child.type === 'bulletList' || child.type === 'orderedList' || child.type === 'taskList') {
      parts.push(`\n${blockText(child)}`);
    } else {
      parts.push(blockText(child));
    }
  }
  return parts.join(' ').replace(/ \n/g, '\n').trim();
}

function blockText(node) {
  if (!node || typeof node !== 'object') return '';
  switch (node.type) {
    case 'doc':
      return (node.content || []).map((n) => blockText(n)).filter((t) => t !== '').join(BLOCK_SEPARATOR);
    case 'paragraph':
      return (node.content || []).map(inlineText).join('');
    case 'heading':
      return `## ${(node.content || []).map(inlineText).join('')}`;
    case 'bulletList':
      return (node.content || []).map((li) => `- ${indentLines(listItemText(li), '  ')}`).join('\n');
    case 'orderedList': {
      const start = Number(node.attrs?.order) || 1;
      return (node.content || []).map((li, i) => `${start + i}. ${indentLines(listItemText(li), '   ')}`).join('\n');
    }
    case 'taskList':
      return (node.content || [])
        .map((item) => {
          if (item.type === 'taskList') return indentLines(`  ${blockText(item)}`, '  ');
          const box = item.attrs?.state === 'DONE' ? '[x]' : '[ ]';
          return `- ${box} ${(item.content || []).map(inlineText).join('')}`;
        })
        .join('\n');
    case 'decisionList':
      return (node.content || []).map((item) => `- ${(item.content || []).map(inlineText).join('')}`).join('\n');
    case 'listItem':
      return listItemText(node);
    case 'codeBlock': {
      const lang = node.attrs?.language ?? '';
      return `\`\`\`${lang}\n${(node.content || []).map(inlineText).join('')}\n\`\`\``;
    }
    case 'blockquote':
      return (node.content || [])
        .map((n) => blockText(n))
        .join('\n')
        .split('\n')
        .map((l) => `> ${l}`)
        .join('\n');
    case 'rule':
      return '---';
    case 'table':
      return (node.content || [])
        .map((row) => (row.content || []).map((cell) => (cell.content || []).map((c) => blockText(c)).join(' ').replace(/\n+/g, ' ').trim()).join(' | '))
        .join('\n');
    case 'panel':
    case 'expand':
    case 'nestedExpand':
    case 'layoutSection':
    case 'layoutColumn':
    case 'bodiedExtension': {
      const title = node.attrs?.title ? `${node.attrs.title}\n` : '';
      return title + (node.content || []).map((n) => blockText(n)).filter(Boolean).join('\n');
    }
    case 'blockCard':
    case 'embedCard':
      return node.attrs?.url ?? '';
    case 'mediaSingle':
    case 'mediaGroup':
    case 'media':
    case 'extension':
      return '';
    default:
      if (Array.isArray(node.content)) {
        const inlineOnly = node.content.every((c) => ['text', 'hardBreak', 'mention', 'emoji', 'inlineCard', 'status', 'date'].includes(c?.type));
        return inlineOnly ? node.content.map(inlineText).join('') : node.content.map((n) => blockText(n)).filter(Boolean).join('\n');
      }
      return inlineText(node);
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
