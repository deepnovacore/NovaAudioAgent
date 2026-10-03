// Mermaid computes its own derived shades, so it needs concrete colours and
// cannot read CSS custom properties. These mirror the palette tokens.
export const mermaidTheme = {
  dark: {
    primaryColor: '#15263b',
    primaryTextColor: '#dce8f7',
    primaryBorderColor: '#4c698f',
    lineColor: '#7397c4',
    secondaryColor: '#1b3047',
    tertiaryColor: '#101c2b',
    fontFamily: 'system-ui, sans-serif',
    fontSize: '15px',
  },
  light: {
    primaryColor: '#e7effa',
    primaryTextColor: '#18212e',
    primaryBorderColor: '#7e9dc4',
    lineColor: '#5b7ba3',
    secondaryColor: '#dae6f5',
    tertiaryColor: '#f2f5fa',
    fontFamily: 'system-ui, sans-serif',
    fontSize: '15px',
  },
} as const;
export type MermaidThemeName = keyof typeof mermaidTheme;
export const currentMermaidTheme = (): MermaidThemeName =>
  document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
