import {isValidElement,useEffect,useRef,useState,type ReactNode} from 'react';
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

function CodeBlock({children}:{children:ReactNode}){
  const pre=useRef<HTMLPreElement>(null),timer=useRef<ReturnType<typeof setTimeout>>(undefined);
  const [status,setStatus]=useState<'idle'|'copied'|'failed'>('idle');
  useEffect(()=>()=>clearTimeout(timer.current),[]);
  const language=isValidElement<{className?:string}>(children)?children.props.className?.replace(/^language-/,'').slice(0,40)||'text':'text';
  async function copy(){
    clearTimeout(timer.current);
    try{await navigator.clipboard.writeText(pre.current?.textContent??'');setStatus('copied');}
    catch{setStatus('failed');}
    timer.current=setTimeout(()=>setStatus('idle'),2000);
  }
  return <div className="code-frame"><div className="code-toolbar"><span>{language}</span><button type="button" aria-label="复制代码" onClick={()=>void copy()}>{status==='copied'?'已复制':status==='failed'?'复制失败，可手动选择':'复制'}</button></div><pre ref={pre}>{children}</pre><span className="sr-only" role="status">{status==='copied'?'代码已复制':status==='failed'?'复制失败，请手动选择代码':''}</span></div>;
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
      components={{ a: ({node:_,...props}) => <a {...props} target="_blank" rel="noreferrer noopener"/>,pre:({children})=><CodeBlock>{children}</CodeBlock> }}
    >{normalizeMath(text)}</ReactMarkdown>
  </div>;
}
