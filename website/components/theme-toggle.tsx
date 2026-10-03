'use client';
import { useSyncExternalStore } from 'react';
import { Moon, Sun } from 'lucide-react';
// The live theme lives on <html>, set before first paint by ThemeScript, so it
// is external state rather than something React owns. Subscribing to the
// attribute keeps the button honest even if the theme changes elsewhere, and
// the server snapshot matches what the markup renders, so hydration is clean.
function subscribe(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributeFilter: ['data-theme'] });
  return () => observer.disconnect();
}
const isLight = () => document.documentElement.dataset.theme === 'light';
const isLightOnServer = () => false;
export function ThemeToggle({ en = false }: { en?: boolean }) {
  const light = useSyncExternalStore(subscribe, isLight, isLightOnServer);
  function toggle() {
    const root = document.documentElement;
    const next = root.dataset.theme === 'light' ? 'dark' : 'light';
    root.dataset.theme = next;
    try {
      localStorage.setItem('theme', next);
    } catch {
      // Private browsing can refuse writes; the theme still applies to this page.
    }
  }
  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={toggle}
      aria-pressed={light}
      aria-label={en ? 'Switch between light and dark theme' : '切换深浅色主题'}
    >
      {/* Both icons ship; CSS picks one off data-theme, so first paint is
          already correct and the markup never differs from the server. */}
      <Sun className="theme-icon theme-icon-light" size={15} aria-hidden="true" />
      <Moon className="theme-icon theme-icon-dark" size={15} aria-hidden="true" />
    </button>
  );
}
