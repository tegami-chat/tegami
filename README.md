# Tegami

**Your chats belong to you. Bring your own AI.**
**トークはあなたのもの。AI は持ち込み自由。**

An open-source messaging app built on Nostr. Now in beta.
Nostr で動く、オープンソースのメッセージアプリです。現在ベータ版です。

[tegami.chat](https://tegami.chat) | [Open in your browser / ブラウザで始める](https://app.tegami.chat) | [Roadmap / ロードマップ](https://tegami.chat/roadmap)

## Free from the platform.

No creepy ads, no news you didn't ask for, no games, no unwanted features. None of it. And your personal data is never sold for corporate marketing.

### プラットフォームから自由に。

気持ち悪い広告も、見たくないニュースも、やりたくないゲームも、いらない機能も、全部ありません。あなたの個人情報を、企業のマーケティングに売ることはありません。

## Use AI your way.

Connect your own AI in a few taps and work with your messages freely via API and MCP. Of course, you're just as free to say no to AI, or not use it at all.

### AI を自由に使う。

自分の AI と、簡単につながります。API や MCP で、メッセージを自由に扱えます。もちろん、AI を断ることも、AI を使わないことも、あなたの自由です。

## No one else can read them.

Messages are encrypted and saved right on your device. Even someone with access to Tegami's servers can't see them.

### 誰にも覗かれない。

メッセージは端末の中で暗号化され、端末に保存されます。Tegami のサーバーにアクセスしても、メッセージを見ることは不可能です。

## What's in this repository / このリポジトリの中身

- `client/` the app (web, iOS, Android), built with Expo / アプリ（ブラウザ、iOS、Android）
- `relay/` the relay that carries sealed messages, on Cloudflare Workers / 封をしたメッセージを届けるリレー
- `agent/` connects the AI on your computer as a friend, with MCP / 自分のパソコンの AI を友達としてつなぐ道具
- `website/` tegami.chat / サイト

## Issues / 不具合と要望

Bug reports and ideas are welcome in GitHub Issues. Pull requests are not accepted for now.
不具合の報告と要望は、GitHub の Issue で受け付けています。コードの取り込み（プルリクエスト）は、いまは受け付けていません。

## License

[AGPL-3.0](LICENSE)
