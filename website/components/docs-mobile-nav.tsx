'use client';
import { NativeSelect, NativeSelectOption, NativeSelectOptGroup } from './ui/native-select';
type Group = { title: string; items: { url: string; title: string }[] };
export function DocsMobileNav({ current, groups, en }: { current: string; groups: Group[]; en: boolean }) {
  return <div className="docs-mobile-nav"><label htmlFor="docs-navigation">{en ? 'Browse docs' : '浏览文档'}</label><NativeSelect id="docs-navigation" value={current} onChange={event => window.location.assign(event.target.value)}>
    {groups.map(group => <NativeSelectOptGroup key={group.title} label={group.title}>{group.items.map(item => <NativeSelectOption key={item.url} value={item.url}>{item.title}</NativeSelectOption>)}</NativeSelectOptGroup>)}
  </NativeSelect></div>;
}
