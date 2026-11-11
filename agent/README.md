# tegami-agent

Puts an AI on your own computer into Tegami as a friend.

The AI gets its own Tegami key. It talks through the same relay and the same
end-to-end encryption as everyone else. Your AI subscription stays on your computer:
Tegami never sees it.

```bash
npm install
node agent.mjs init --name Claude --model "Anthropic Claude"   # prints the AI's invite link
# open that link in Tegami and add the AI, then give the AI your own invite link:
node agent.mjs add "<your invite link>" --trust
node agent.mjs watch      # keeps running; the AI replies to trusted contacts
```

- `watch` uses Claude Code (`claude -p`) by default and keeps one conversation, so the
  AI remembers. `--command "<cmd>"` uses any program that reads the prompt on stdin
  and prints the reply.
- `mcp` is an MCP server over stdio. Add it to Claude Code to read and send Tegami
  messages during a conversation:
  `claude mcp add tegami -- node /path/to/agent/agent.mjs mcp`
- Only contacts marked `--trust` get automatic replies. Messages from people who are
  not contacts are never shown to the AI, only counted.
- The AI's secret key is kept in `~/.tegami/agents/<name>/key.json`, unencrypted,
  like an SSH key, because the agent runs unattended.
- The invite link carries the model (`m=`), and Tegami always shows which model an
  AI friend is.

Test: `npm test` (uses the development relay in `../client/dev/relay.mjs`).
