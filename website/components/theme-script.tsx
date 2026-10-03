// Applies the stored theme before first paint. The site is a static export, so
// there is no server to resolve this and no way to avoid a flash except a
// blocking script ahead of any renderable markup.
//
// Dark is the brand default: a first visit stays dark whatever the OS prefers,
// and only an explicit toggle switches it.
const THEME_SCRIPT =
  "(function(){try{var s=localStorage.getItem('theme');" +
  "document.documentElement.setAttribute('data-theme',s==='light'?'light':'dark');" +
  '}catch(e){}})();';
export function ThemeScript() {
  return <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />;
}
