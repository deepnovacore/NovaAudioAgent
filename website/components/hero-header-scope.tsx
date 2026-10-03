'use client';
import { useEffect } from 'react';
// The header is fixed and a sibling of the hero, so it cannot inherit the
// hero's dark scope. While the starfield is behind it the header has to stay
// dark; once it scrolls onto the page body it follows the active theme.
export function HeroHeaderScope() {
  useEffect(() => {
    const header = document.querySelector('.header');
    const hero = document.querySelector('#overview');
    if (!header || !hero) return;
    const observer = new IntersectionObserver(
      ([entry]) => header.classList.toggle('theme-dark', entry.isIntersecting),
      { threshold: 0 },
    );
    observer.observe(hero);
    return () => observer.disconnect();
  }, []);
  return null;
}
