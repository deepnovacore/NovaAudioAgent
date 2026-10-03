import { ArrowUpRight } from 'lucide-react';
import { youtubeUrl } from '../lib/docs-navigation';
export function YouTubeCard({ en = false }: { en?: boolean }) {
  return <figure className="youtube-card">
    <div className="youtube-frame"><iframe
      src="https://www.youtube-nocookie.com/embed/t1c-2O-QsxE?rel=0"
      title={en ? 'Nova Audio Agent — product demo on YouTube' : 'Nova Audio Agent — YouTube 产品演示'}
      loading="lazy"
      allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
      referrerPolicy="strict-origin-when-cross-origin"
      allowFullScreen
    /></div>
    <figcaption><span>{en ? 'Nova in action' : '看看 Nova 如何工作'}</span><a href={youtubeUrl} target="_blank" rel="noreferrer">{en ? 'Open on YouTube' : '在 YouTube 打开'} <ArrowUpRight size={14} /></a></figcaption>
  </figure>;
}
