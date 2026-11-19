# tegami.chat 利用者向けのページ（site）

Astro のプロジェクトで、見た目は自作です。テンプレートは使っていません。

トップ、安全の仕組み、よくある質問、運営者情報、他アプリとの比較、ロードマップ、稼働状況、プライバシーポリシーの8ページを、英語（`/`）と日本語（`/ja/`）で作ります。開発者向けのページは `..\docs`（Starlight）です。

## 構成

- `src/layouts/Base.astro`：head、ヘッダー、フッター、スクリプトの読み込み。
- `src/components/Header.astro`、`Footer.astro`、`PlatformPills.astro`、`Logo.astro`、`ExtMark.astro`：全ページ共通の部品。
- `src/components/home/`：トップの節（ヒーロー、3つの柱、動く比較、機能の一覧、AI、自分仕様、寄付、最後の呼びかけ）。
- `src/components/pages/`：ほかのページ。`PageView.astro` がページ名から選ぶ。
- `src/styles/global.css`：Tailwind CSS 4。色（forest、nostr、paper、night）とフォントは `@theme` に置く。
- `src/site.ts`：ページの一覧、ページ名と説明、`t(key, lang)`。

## ビルド

`..\` で `node build.mjs`。site と docs を作り、結果を `..\public\` へ写す。`/.well-known`、`_headers`、`_redirects` には触らない。

## 文章

`src/content/dict.json` に、短い文から長い本文までを `{en, ja}` の組で置く。部品は `t(key, lang)` で引く。ページ名、ナビ、フッターのラベル、`<title>` は同じ言葉にそろえる。

## スクリプト（public）

- `diff.js`：トップの動く比較（Web Animations API）。
- `status.js`：稼働状況。`https://relay.tegami.chat` に問い合わせて表示する。
- `theme-init.js`：描画前にダークモードを決める。`theme` と `starlight-theme` の両方を読み、開発者向けページと選択を共有する。
- `site.js`：テーマの切り替えとメニュー。

## CSP

`script-src 'self'; style-src 'self'`（'unsafe-inline' なし）。Astro の `security.csp` が `<meta>` を出し、`inlineStylesheets: 'never'` と `assetsInlineLimit: 0` でインラインを残さない。`connect-src` は `'self' https://relay.tegami.chat`。`src/inline-hashes.json` は空のままにする。空でなくなると `build.mjs` が止まる。ヘッダー側の CSP は `..\public\_headers`。
