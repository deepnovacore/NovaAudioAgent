import { sitePath } from '../../lib/site-path';
import type { Metadata } from 'next';
import { ThemeScript } from '../../components/theme-script';
import '../globals.css';
export const metadata: Metadata = {
  title: 'NovaAudioAgent — Your Personal Agent and Voice Assistant',
  description: 'Your personal agent and voice assistant: todos, ideas and goals on one workbench, memory you can trace, and tasks checked against evidence.',
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
