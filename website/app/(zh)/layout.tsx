import { sitePath } from '../../lib/site-path';
import type { Metadata } from 'next';
import { ThemeScript } from '../../components/theme-script';
import '../globals.css';
export const metadata: Metadata = {
  title: 'Nova Audio Agent — 随时交流，专心做事。',
  description:
    '实时语音、放待办与可验收任务的 Workbench、有据可查的个人记忆、视觉监控和知识库，让小诺在值得你关注时主动开口。',
  icons: { icon: sitePath('/favicon.svg') },
  alternates: { languages: { en: sitePath('/'), 'zh-CN': sitePath('/zh'), 'x-default': sitePath('/') } },
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html suppressHydrationWarning lang="zh-CN">
      <body>
        <ThemeScript />
        {children}
      </body>
    </html>
  );
}
