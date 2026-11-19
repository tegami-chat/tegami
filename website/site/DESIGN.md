# Tegami サイトのデザインの決まり

ユーザー向けサイト（この `site` フォルダ）の余白、文字の大きさ、色、幅を、少数の決まった値で管理するための説明です。見た目は変えず、値を1か所に集めています。

## ルール

- ページとホームの各セクションは、`src/components/ui/` の部品を組み合わせて作ります。
- 新しい値（色、幅、文字の大きさ、余白、角丸、影）が要るときは、先に `src/styles/global.css` のトークンに足します。ページの中に直接書きません。
- `scripts/check-design.mjs` が `node build.mjs` のたびに `src/components/home` と `src/components/pages` を検査します。決まりを破る書き方があるとビルドが止まります。

## トークン（`src/styles/global.css`）

| 種類 | 値 |
|---|---|
| 色 | 意味の名前だけを使います。page、surface、surface-muted、fg、fg-muted、line、line-strong、hover、accent、accent-strong、accent-soft、on-accent、accent-2、accent-2-soft、warn、warn-soft、quiet、quiet-soft、danger、danger-soft。それぞれにライトとダークの値があり、ページ側で `dark:` を書く必要はありません |
| 幅 | 3つです。narrow（48rem、読み物のページ）、content（64rem、トップとロードマップ）、wide（72rem、ヘッダーとフッター）。左右の余白は `pad-gutter`（1rem）の1種類です |
| 文字の大きさ | text-display、text-title、text-section、text-subsection、text-lead、text-body、text-small、text-caption の8種類です。大文字化はしません。文中の強調は `emphasis` です |
| 縦の余白 | `pad-page`（読み物ページの先頭）、`pad-section`（トップのセクション）、`pad-compact`（一覧の中の1項目）の3種類です |
| 間隔 | gap、space、margin は 0、1、2、3、4、6、8、12、16 の段だけです |
| 角丸 | rounded-control（小さい箱）、rounded-box（カードと枠）、rounded-pill（ボタンとバッジ）の3種類です |
| 影 | shadow-card と shadow-pop の2種類です |

## 部品（`src/components/ui/`）

- Container は幅を決めます（prose、content、wide。prose は narrow の幅です）。
- Section は縦の余白（rhythm）、背景（tone: default、muted、inverse）、幅、区切り線、アンカー用の `id` を持ちます。
- SectionHeading は小見出し（eyebrow）、見出し、導入文の組です。
- Heading は見出し1つです。level と style（display、title、section、subsection）で決めます。
- Button は primary と secondary、サイズ sm と md、外部リンクの印を持ちます。
- Badge は状態の表示です（available、coming、dev、planned、decided、discussing）。語は辞書から取り、末尾にコロンは付けません。
- Card は plain、outlined、muted、accent の4種類です。
- Prose は読み物の本文の流れです。見出しの上の余白、リスト、リンクの色が1種類に決まります。
- Table は横にあふれると枠の中でスクロールし、`sticky` を付けると先頭の列が残ります。
- Disclosure は開閉する説明（FAQ）です。

## 新しい値が要るとき

1. `global.css` にトークンか部品を足します。
2. `DESIGN.md` のこの表を直します。
3. ページ側は部品の名前だけで書きます。

ホームの動く比較図（`public/diff.js`）のように、内容に固有の描画だけは、この決まりの外に置いています。
