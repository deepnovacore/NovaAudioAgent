'use client';
import { useEffect, useRef } from 'react';
import { currentMermaidTheme, mermaidTheme } from '../lib/mermaid-theme';
export function DocBody({ html }: { html: string }) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let cancelled = false;
    const nodes = Array.from(
      root.current?.querySelectorAll<HTMLElement>('.mermaid') ?? [],
    );
    if (!nodes.length) return;
    // Rendering replaces each node's source with an SVG and marks it done, so
    // re-theming means restoring the source first. Capture it up front.
    const sources = new Map(nodes.map((node) => [node, node.textContent ?? '']));
    let pending = Promise.resolve();
    function draw(theme: keyof typeof mermaidTheme) {
      pending = pending
        .then(async () => {
          if (cancelled) return;
          const { default: mermaid } = await import('mermaid');
          if (cancelled) return;
          mermaid.initialize({
            startOnLoad: false,
            theme: 'base',
            securityLevel: 'strict',
            themeVariables: { ...mermaidTheme[theme] },
          });
          for (const node of nodes) {
            node.removeAttribute('data-processed');
            node.textContent = sources.get(node) ?? '';
          }
          await mermaid.run({ nodes });
        })
        .catch(console.error);
    }
    draw(currentMermaidTheme());
    // Redraw on any theme change, whatever flips the attribute.
    const observer = new MutationObserver(() => draw(currentMermaidTheme()));
    observer.observe(document.documentElement, { attributeFilter: ['data-theme'] });
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [html]);
  return (
    <div ref={root} className="markdown-body" dangerouslySetInnerHTML={{ __html: html }} />
  );
}
