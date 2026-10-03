import { sitePath } from '../../lib/site-path';
import type { Metadata } from 'next';
import { ThemeScript } from '../../components/theme-script';
import '../globals.css';
export const metadata: Metadata = {
  title: 'Nova Audio Agent — Stay in conversation. Keep work moving.',
  description:
    'Real-time voice, a Workbench for todos and verifiable tasks, personal memory grounded in your sources, camera monitoring, and document knowledge. Nova speaks up when it matters.',
  icons: { icon: sitePath('/favicon.svg') },
  alternates: { languages: { en: sitePath('/'), 'zh-CN': sitePath('/zh'), 'x-default': sitePath('/') } },
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html suppressHydrationWarning lang="en">
      <body>
        <ThemeScript />
        {children}
      </body>
    </html>
  );
}
