# Tegami サイトのデザインの決まり

ユーザー向けサイト（この `site` フォルダ）の余白、文字の大きさ、色、幅を、少数の決まった値で管理するための説明です。見た目は変えず、値を1か所に集めています。

## ルール

- ページとホームの各セクションは、`src/components/ui/` の部品を組み合わせて作ります。
- 新しい値（色、幅、文字の大きさ、余白、角丸、影）が要るときは、先に `src/styles/global.css` のトークンに足します。ページの中に直接書きません。
- `scripts/check-design.mjs` が `node build.mjs` のたびに `src/components/home` と `src/components/pages` を検査します。決まりを破る書き方があるとビルドが止まります。

## トークン（`src/styles/global.css`）

| 種類 | 値 |
|---|---|
| 色 | 意味の名前だけを使います。page、surface、surface-muted、fg、fg-muted、line、line-strong、hover、accent、accent-strong、accent-soft、on-accent、warn、quiet、quiet-soft、danger。それぞれにライトとダークの値があり、ページ側で `dark:` を書く必要はありません |
| 幅 | 3つです。narrow（48rem、読み物のページ）、content（64rem、トップ）、wide（72rem、ヘッダーとフッター）。左右の余白は `pad-gutter`（1rem）の1種類です。ほかに、文書ページの右の目次の幅 `container-toc`（15rem）があります |
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
- Card は plain、outlined、muted、accent、soft（薄い灰色）、note（薄い灰色に、左に細い琥珀色の線。1ページに1つの注意）の6種類です。
- Prose は読み物の本文の流れです。見出しの上の余白、リスト、リンクの色が1種類に決まります。
- Table は横にあふれると枠の中でスクロールし、`sticky` を付けると先頭の列が残ります。`matrix` を付けると比較表の見た目（丸い枠、薄い線）になり、`data-hl` を付けた列が強調されます。
- Disclosure は開閉する説明（FAQ）です。`acc` というクラスの枠の中に並べます（枠と質問どうしの線は枠が描きます）。

### 文書ページの部品（/how /status /compare /faq /roadmap）

- DocPage は文書ページの枠です。上の帯（題、導入文、絵）、本文の列、64rem から右に付く目次（固定表示）を持ちます。64rem より狭い画面では、目次はページの先頭で開閉するブロックになります。`toc` に節の id と見出しを渡し、絵は `art` スロットに入れます。現在の節の印は `public/doc-toc.js` が付けます（`aria-current`。印をつけるだけで、通信はしません）。
- DocSection は文書ページの1つの節です。アンカー用の `id`、アイコンの四角、h2 を持ちます。`card` で節全体を Card に入れ、`compact` で見出しを小さくします。
- Icon は Lucide のアイコン（`@lucide/astro` 1.68.0、ISC ライセンス）です。使うものだけを `Icon.astro` の一覧に足します。画面には出ますが、読み上げからは外します（意味は隣の文が持ちます）。
- IconChip はアイコンを入れた四角（節の目印、リストの項目の目印）です。色は tone（quiet が既定の灰色、accent は灰色の四角に緑のアイコン、solid は緑の四角で1ページに多くて1つ）、大きさは size（sm、md、lg）で決めます。
- Mark は比較表のセルの小さな丸い印（yes、part、no、unknown）です。
- Orbit は上の帯の絵です。大きなアイコンのまわりに小さなアイコンを3つ置きます。

これらの見た目の規則（`doc-cols`、`doc-toc`、`orbit`、`chip`、`iconlist`、`steps`、`matrix`、`status-hero`、`stat`、`chart-card`、`acc`）は `global.css` にあります。ページの中では、これらのクラス名と部品だけを使います。

## 色の使い方

文書ページ（/how /status /compare /faq /roadmap）は、灰色の面を基本にします。

- 強調の色は緑（accent）の1色だけです。使うのは、目次の現在の項目、リンク、主ボタン、/compare の Tegami の列と「できる」の印、完成した状態のバッジ、アイコンの緑の差し色に限ります。
- 紫（Nostr の色）は、Nostr そのものを指すときだけ使います（ホームの見出しの一部）。飾りには使いません。部品からは外しました。
- 琥珀色（warn）は、「まだ足りないところ」のような、1ページに1つの注意にだけ使います。薄い塗りは使わず、灰色のカードの左に細い線を引くだけにします。
- 状態の緑と赤は、/status の稼働を示す点と文字だけに使います。大きな塗りのカードにはしません。
- 上の帯は背景を塗らず、絵は灰色の線で描き、緑は1か所だけにします。
- IconChip は灰色の四角が基本です。/compare の印は形で意味を伝え、色は控えめにします（「できる」だけ緑、「できない」は薄い赤の記号で背景なし）。
- ダークモードも、トークンの値が切り替わるだけで同じ規則です。ページの中に `dark:` を書きません。

## 新しい値が要るとき

1. `global.css` にトークンか部品を足します。
2. `DESIGN.md` のこの表を直します。
3. ページ側は部品の名前だけで書きます。

/status の動く部分（`public/status.js`。カードの色は `data-state` で、数字と棒グラフは `stat` と `chart-card` で決まります）と、ホームの動く比較図（`public/diff.js`）のように、内容に固有の描画だけは、この決まりの外に置いています。
