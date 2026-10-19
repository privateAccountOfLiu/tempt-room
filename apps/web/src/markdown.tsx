import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';

const protectedBlocks = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/g;

/**
 * Agents often emit LaTeX with \( \) or \[ \] delimiters, while remark-math
 * only understands $ / $$. Normalize the common forms without touching code.
 */
function normalizeMath(text: string): string {
  if (!text.includes('\\(') && !text.includes('\\[')) return text;
  return text.split(protectedBlocks).map((part, index) => {
    if (index % 2 === 1) return part;
    return part
      .replace(/\\\[([\s\S]+?)\\\]/g, (_, body: string) => `\n$$\n${body.trim()}\n$$\n`)
      .replace(/\\\(([\s\S]+?)\\\)/g, (_, body: string) => `$${body.trim()}$`);
  }).join('');
}

/**
 * Chat message renderer: GitHub-flavored Markdown plus KaTeX math. Raw HTML is
 * not enabled, so agent output cannot inject markup into the room.
 */
export function Markdown({ text }: { text: string }) {
  return <div className="markdown-body">
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[[rehypeKatex, { throwOnError: false, strict: false, trust: false }]]}
      components={{ a: ({ ...props }) => <a {...props} target="_blank" rel="noreferrer noopener"/> }}
    >{normalizeMath(text)}</ReactMarkdown>
  </div>;
}
