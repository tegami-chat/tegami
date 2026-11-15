// Tailwind for tegami.chat. The pages are written in src/ and turned into
// public/ (English) and public/ja/ (Japanese) by build.mjs.
module.exports = {
  content: ['./public/**/*.html', './public/site.js', './public/status.js'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        forest: { 50: '#e3f0e8', 300: '#7fd7a8', 600: '#106c4a', 700: '#0b5a3d', 950: '#0b1a12' },
        nostr: { 300: '#c9a2ff', 600: '#7c2eda' },
        paper: { DEFAULT: '#f4f1e8', dark: '#171b18' },
        night: { DEFAULT: '#121614', card: '#1c221f', line: '#2c3430' },
      },
      fontFamily: { sans: ['-apple-system', 'BlinkMacSystemFont', '"Hiragino Sans"', '"Yu Gothic UI"', '"Noto Sans JP"', 'sans-serif'] },
    },
  },
};
