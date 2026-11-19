# tegami.chat 利用者向けのページ（site）

トップ、安全の仕組み、よくある質問、運営者情報、他アプリとの比較、ロードマップ、稼働状況、プライバシーポリシーの8ページを、英語（`/`）と日本語（`/ja/`）で作る Astro のプロジェクトです。開発者向けのページは `..\docs`（Starlight）です。

## 土台のテンプレート

- 採用：AstroWind（https://github.com/onwidget/astrowind）。コミット `14e1a691` を取り込んだ。ライセンスは MIT で、通知文は `LICENSE.md` に残してある。
- 選んだ理由：Astro と Tailwind CSS 4 で作られ、ヒーロー、機能の一覧、よくある質問、料金カード、行動の呼びかけ、フッターなどの部品が揃っていて、ダークモードと prose（長文の整形）もある。開発者向けと同じ Astro 7.4.3 で動く。
- 版：astro 7.4.3、tailwindcss と @tailwindcss/vite 4.3.3、astro-icon 1.1.5（正確な版は `package.json` と `package-lock.json`）。
- 使わなかった部品（ブログ、デモのページ、価格表、お問い合わせフォームなど）は消してある。

## ビルド

`..\` で `node build.mjs`。site と docs を作り、結果を `..\public\` へ写す。`/.well-known`、`_headers`、`_redirects` には触らない。

## 文章

- `src/content/dict.json`：短い文（`{en, ja}` の組）。`src/site.ts` の `t(key, lang)` で引く。
- `src/content/prose/`：長い本文（how、privacy、about）の HTML 片。テンプレートの `prose` の見た目に任せる。
- `src/site.ts` の `fixLinks`：古い下書きのファイル名のリンクを、言語ごとの正しい道に直す。
- 見た目の自作は色（`tailwind.css` の `@theme`）、ロゴ、ナビ、フッターの設定だけ。

## テンプレートに無くて足した部品

- `PlatformPills.astro`：ブラウザ版へのリンクと、準備中の端末（iPhone、Android、Windows、Mac、Linux）の札。テンプレートにはアプリの対応端末を示す部品が無い。
- `DiffScenes.astro` と `public/diff.js`：トップの「差分」の動くアニメーション。Web Animations API で動く。
- `StatusLive.astro` と `public/status.js`：稼働状況。`https://relay.tegami.chat` に実際に問い合わせて表示する。
- `LanguageSwitch.astro`：英語と日本語の切り替え（テンプレートは言語切り替えを持たない）。
- `public/theme-init.js`：ダークモードの初期設定（インラインのスクリプトを避けるため外部ファイルにした）。

## CSP

利用者のページは `script-src 'self'; style-src 'self'`（'unsafe-inline' なし）。Astro の `security.csp` が `<meta>` を出し、`inlineStylesheets: 'never'` と `assetsInlineLimit: 0` でインラインを残さない。`connect-src` は `'self' https://relay.tegami.chat`。`src/inline-hashes.json` は空のままにする。空でなくなると `build.mjs` が止まる。ヘッダー側の CSP は `..\public\_headers`。
