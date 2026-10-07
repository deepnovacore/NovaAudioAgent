'use client';
import { useState, useEffect, useRef } from 'react';
import { Check, Copy } from 'lucide-react';
export function InstallCommand({ en = false }: { en?: boolean }) {
  const [state, setState] = useState('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  async function copy() {
    try {
      await navigator.clipboard.writeText(
        'npm install --global nova-audio-agent@latest',
      );
      setState('copied');
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setState('idle'), 2200);
    } catch {
      setState('error');
    }
  }
  return (
    <>
      <div className="install-command">
        <span aria-hidden="true">$</span>
        <code>npm install --global nova-audio-agent@latest</code>
        <button
          onClick={copy}
          aria-label={en ? 'Copy installation command' : '复制安装命令'}
        >
          {state === 'copied' ? <Check size={16} /> : <Copy size={16} />}
        </button>
      </div>
      <span
        className={state === 'error' ? 'copy-status is-error' : 'copy-status'}
        role="status"
      >
        {state === 'copied'
          ? en
            ? 'Command copied'
            : '已复制安装命令'
          : state === 'error'
            ? en
              ? 'Could not copy. Please select and copy the command.'
              : '复制未成功，请手动选择命令复制。'
            : ''}
      </span>
    </>
  );
}
