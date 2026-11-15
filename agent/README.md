# tegami-agent

Puts an AI on your own computer into Tegami as a friend.

The AI gets its own Tegami key. It talks through the same relay and the same
end-to-end encryption as everyone else. Your AI subscription or API key stays on your
computer: Tegami never sees it.

## Connect with a QR code

```bash
npm install
node agent.mjs pair --name Claude
```

`pair` shows a QR code in the terminal (`--browser` also opens it as a page). In Tegami,
open 友だち追加 > QRコードスキャン and read it, then press 追加. That is all:

- Tegami adds the AI as a friend, showing which model it is.
- The app sends the code back to the AI, sealed for the AI only, with your own invite
  link. The AI now replies to you, and registers with the relay using the invite code
  in your link.
- The code works once and for 10 minutes (`--minutes` up to 60). Someone who reads the
  same QR code later gets nothing, and the terminal says who the AI paired with.

Then keep the AI answering: `node agent.mjs autostart on` (or `node agent.mjs watch`).

Without the app's QR code scan, the same can be done by hand:

```bash
node agent.mjs init --name Claude                 # prints the AI's invite link
node agent.mjs add "<your invite link>" --trust   # the AI replies to you
```

## Which AI writes the replies

By default the replies come from Claude Code (`claude -p`) signed in with your own
plan, in one conversation that continues, so the AI remembers. To use something else:

```bash
node agent.mjs backend ollama --model llama3.2                          # Ollama on this computer
node agent.mjs backend local --model qwen --url http://localhost:8080/v1  # llama.cpp, LM Studio, vLLM
node agent.mjs backend anthropic --model <model>                        # your Anthropic API key
node agent.mjs backend openai --model <model>                           # your OpenAI API key
node agent.mjs backend gemini --model <model>                           # your Gemini API key
node agent.mjs backend openrouter --model <vendor/model>                # your OpenRouter API key
node agent.mjs key <backend>      # asks for the API key (hidden), or reads it from stdin
node agent.mjs backend            # shows the current backend
node agent.mjs try "hello"        # asks the AI once, to check that it answers
```

- API keys are kept in `~/.tegami/agents/<name>/keys.json` and only sent to that API,
  over https (or to this computer). They are never taken on the command line, so they
  do not end up in your shell history, and never written to the log.
- The invite link's model (`m=`) follows the backend, for example `OpenAI gpt-…` or
  `llama3.2 (Ollama)`: Tegami always shows which model an AI friend is.
  `--label` sets it yourself. People who added the AI before see the new model after
  they read a new QR code.
- With an API backend, the AI keeps the last 20 turns with each person in
  `history.json`.
- `watch --command "<cmd>"` uses any program that reads the prompt on stdin and prints
  the reply.
- Antigravity (`agy`) is not supported: its terms do not allow other programs to use it.
  Tegami never holds your sign-in to any AI service.

## Keep it running

`node agent.mjs autostart on` starts the watcher every time you log in, with no window:

- Windows: a Task Scheduler task named "Tegami agent claude".
- macOS: a launchd agent, `~/Library/LaunchAgents/chat.tegami.agent.claude.plist`.
- Linux: a systemd user unit, `~/.config/systemd/user/tegami-agent-claude.service`
  (it runs while you are logged in; `loginctl enable-linger` keeps it running after
  you log out).

`autostart status` shows whether it is running and the last log lines; `autostart off`
removes it and stops the watcher. Only one watcher runs per AI friend, and messages that
arrived while the computer was off (up to a day) are answered when it starts again.

## More

- `mcp` is an MCP server over stdio. Add it to Claude Code to read and send Tegami
  messages during a conversation:
  `claude mcp add tegami -- node /path/to/agent/agent.mjs mcp`
- Through MCP the AI can also ask your Tegami app to act for you. Your app decides with
  its AI permissions (settings → AIの権限); the AI never holds your key:
  `tegami_owner_friends` (your friend list), `tegami_send_as_owner` (a message to a
  friend in your name: sent, or waiting for you to press 送る; your friend sees that an
  AI wrote it), `tegami_talk_to_ai` (permission to talk to another person's AI, with a
  daily limit; you can take it back). A group, or a 1:1 chat you call the AI into, reaches
  the AI only while every member has said yes.
- Only trusted contacts (paired, or added with `--trust`) get automatic replies.
  Messages from people who are not contacts are never shown to the AI, only counted.
- The AI's secret key is kept in `~/.tegami/agents/<name>/key.json`, unencrypted,
  like an SSH key, because the agent runs unattended.
- `--agent <folder name>` (default `claude`) picks which AI friend a command is for.

Test: `npm test` (uses the development relay in `../client/dev/relay.mjs`;
`RELAY_PORT` picks its port).
