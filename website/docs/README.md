# 開発者向けドキュメント（Astro Starlight）

tegami.chat の /developers と /ja/developers の開発者向けドキュメント（15ページ）を作る Starlight のプロジェクトです。左のサイドバーは「はじめに」「仕組み」「ガイド」「リファレンス」「比較とよくある質問」の5つの組に分けています。

## 作り直す1つのコマンド

`website` フォルダで `node build.mjs` を実行します。次の順に動きます。

1. Tailwind でサイトの CSS を作り、他のページを書き出す。
2. `docs\node_modules` が無ければ `npm ci` を実行する。
3. `docs` で `npm run build` を実行する（`astro build` のあとに `scripts\inline-hashes.mjs`）。
4. `docs\dist` の `developers`、`ja\developers`、`_astro`、`pagefind` を `public` に写す。

`docs\dist` は Git に入れません。`public` に写された結果は Git に入ります。

## 構成

- `src\content\docs\developers\*.mdx` が英語、`src\content\docs\ja\developers\*.mdx` が日本語。
- `astro.config.mjs` に、サイドバーの順番と日本語の名前、ヘッダーの設定がある。
- `src\components\SocialIcons.astro` がヘッダーの「ホーム、安全の仕組み、よくある質問」へのリンク。
- `src\components\ArchMap.astro` と `src\diagrams\arch.*.svg` が概要の構成図。
- ページを足す時は、両言語に mdx を足し、`astro.config.mjs` のサイドバーの組に1行足す。
- 古い `/developers/protocol` は `public\_redirects` で `/developers/nostr` に転送している（日本語も同じ）。
- サイトのフッターの開発者向けリンクは `website\src\_layout.html` と `build.mjs` の `DRAFT_LINKS` にある。

## CSP

`public\_headers` の `/*` は `script-src 'self'; style-src 'self'` で、`unsafe-inline` を許していません。docs はこの方針のまま動かします。

- `build.inlineStylesheets: 'never'` で CSS を別ファイルにする。
- `security.csp` が、バンドルしたスクリプトとスタイルのハッシュを各ページの meta に書く。
- Starlight が出す `style=""` と、ハッシュされないインラインのスクリプトは、`scripts\inline-hashes.mjs` がビルド後の HTML から集めて `src\inline-hashes.json` に書く。一覧が変わった時は、もう一度ビルドする。
- `public\_headers` に `/developers*`、`/ja/developers*`（ヘッダーの CSP を外し、meta の CSP に任せる）と、`/pagefind/*`（検索のワーカーに `connect-src 'self'` と `wasm-unsafe-eval` を許す）のブロックがある。

## 版

`astro` 7.4.3、`@astrojs/starlight` 0.42.8。`package.json` は版を固定している。
