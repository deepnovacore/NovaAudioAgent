import { sitePath } from '../../lib/site-path';
import type { Metadata } from 'next';
import { ThemeScript } from '../../components/theme-script';
import '../globals.css';
export const metadata: Metadata = {
  title: 'Nova Audio Agent — 随时交流，专心做事。',
  description:
    '理解你的上下文，通过语音和文字推进工作，结果可验收，主动有分寸的个人 Agent。',
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
