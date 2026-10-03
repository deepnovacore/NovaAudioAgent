import { sitePath } from '../../../lib/site-path';
import { DocsPage } from '../../../components/docs-page';
export const metadata = {
  title: '使用文档 · Nova Audio Agent',
  alternates: { languages: { 'zh-CN': sitePath('/docs'), en: sitePath('/en/docs') } },
};
export default function Page() {
  return <DocsPage />;
}
