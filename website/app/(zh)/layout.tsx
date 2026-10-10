import { sitePath } from '../../lib/site-path';
import type { Metadata } from 'next';
import { ThemeScript } from '../../components/theme-script';
import '../globals.css';
export const metadata: Metadata = {
  title: 'NAA — 你的个人 Agent 与语音助手',
  description: '你的个人 Agent 与常驻语音助手：理解上下文，前后双脑协作，主动有分寸。',
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
