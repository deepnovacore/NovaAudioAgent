import { sitePath } from '../../../../lib/site-path';
import pages from '../../../../generated/docs.json';
export const dynamicParams = false;
export function generateStaticParams() { return pages.filter(p => p.lang === 'zh-CN' && p.slug).map(p => ({ slug: p.slug.split('/') })); }
import { DocsPage } from '../../../../components/docs-page';
export default async function Page({ params }: { params: Promise<{ slug: string[] }> }) {
 const { slug } = await params;
 return <DocsPage en={false} slug={slug.join('/')} />;
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string[] }> }) {
 const { slug } = await params; const page = pages.find(p => p.lang === 'zh-CN' && p.slug === slug.join('/'));
 return { title: `${page?.title || 'Docs'} · Nova Audio Agent`, alternates: { languages: page ? { 'zh-CN': sitePath(page.lang === 'zh-CN' ? page.url : page.alternate), en: sitePath(page.lang === 'en' ? page.url : page.alternate) } : {} } };
}
