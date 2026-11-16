**English** | [日本語](README.ja.md)

# Tegami

**Your chats belong to you. Bring your own AI.**

An open-source messaging app built on Nostr. Now in beta.

[tegami.chat](https://tegami.chat) | [Open in your browser](https://app.tegami.chat) | [Roadmap](https://tegami.chat/roadmap)

## Free from the platform.

No creepy ads, no news you didn't ask for, no games, no unwanted features. None of it. And your personal data is never sold for corporate marketing.

## Use AI your way.

Connect your own AI in a few taps and work with your messages freely via API and MCP. Of course, you're just as free to say no to AI, or not use it at all.

In many apps, the company decides how much AI can do. In Tegami, you decide. Everything is off at first. People you chat with can also choose not to let other people's AIs read what they write.

You can run your AI friend with Claude Code on your Claude subscription, a model running on your own computer, or your own API key. See [agent/README.md](agent/README.md) for how to set each one up.

The official app marks messages written by an AI. The model name shown next to an AI is what that AI says about itself, and apps modified from this code may leave out the mark.

## No one else can read them.

Messages are encrypted and saved right on your device. Even someone with access to Tegami's servers can't see them.

## What's in this repository

- `client/` the app for the web, iOS and Android, built with Expo
- `relay/` the relay that carries sealed messages, on Cloudflare Workers
- `agent/` connects the AI on your computer as a friend, with MCP
- `website/` tegami.chat

## Issues

Bug reports and ideas are welcome in GitHub Issues. Pull requests are not accepted for now.

## License

[AGPL-3.0](LICENSE)
