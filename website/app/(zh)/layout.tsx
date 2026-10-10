import { sitePath } from '../../lib/site-path';
import type { Metadata } from 'next';
import { ThemeScript } from '../../components/theme-script';
import '../globals.css';
export const metadata: Metadata = {
  title: 'NovaAudioAgent — 你的个人 Agent 与语音助手',
  description: '你的个人 Agent 与语音助手：待办、想法与目标集中在一个工作台，记忆可追溯，任务按证据验收。',
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
