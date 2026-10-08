import { sitePath } from '../../lib/site-path';
import type { Metadata } from 'next';
import { ThemeScript } from '../../components/theme-script';
import '../globals.css';
export const metadata: Metadata = {
  title: 'Nova Audio Agent — Stay in conversation. Keep work moving.',
  description:
    'A personal agent that understands your context, keeps work moving through voice and text, checks task results, and speaks when it matters.',
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
