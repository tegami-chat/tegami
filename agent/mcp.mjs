// MCP server for tegami-agent: lets an AI read and send Tegami messages as itself.
//
// Messages from people who are not in the AI's contacts are counted but never shown,
// so a stranger cannot slip instructions into the AI's conversation.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { shortId } from './lib.mjs';

const text = (value) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] });

export async function startMcp(agent) {
  const server = new McpServer({ name: 'tegami', version: '0.1.0' });
  const nameOf = (pubkey) => (pubkey === agent.pubkey ? agent.profile.name : agent.contacts.find((c) => c.pubkey === pubkey)?.name ?? shortId(pubkey));
  // A chat is known when every other participant is a contact (groups included).
  const known = (room) => room.split(',').every((k) => agent.contacts.some((c) => c.pubkey === k));
  const view = (m) => ({ from: nameOf(m.from), with: m.peer.split(',').map(nameOf).join(', '), text: m.text, at: new Date(m.at * 1000).toISOString() });

  server.registerTool(
    'tegami_contacts',
    { description: 'List the people this AI can message on Tegami.', inputSchema: {} },
    async () => text(agent.contacts.map((c) => ({ name: c.name, trusted: c.trusted }))),
  );

  server.registerTool(
    'tegami_inbox',
    {
      description:
        'Read Tegami messages. By default returns messages that arrived since the last read and marks them read. Messages from strangers are only counted.',
      inputSchema: {
        with: z.string().optional().describe('Only the conversation with this contact (name).'),
        all: z.boolean().optional().describe('Also include messages that were already read.'),
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    async ({ with: who, all, limit }) => {
      await agent.connect();
      const peer = who ? agent.contact(who)?.pubkey : undefined;
      if (who && !peer) return text(`Unknown contact: ${who}`);
      const since = all ? 0 : agent.state.lastRead;
      const fresh = agent.messages.filter((m) => m.at > since && (!peer || m.peer === peer));
      const shown = fresh.filter((m) => known(m.peer)).slice(-(limit ?? 50));
      const strangers = new Set(fresh.filter((m) => !known(m.peer)).map((m) => m.peer)).size;
      if (!all && agent.messages.length) {
        agent.state.lastRead = Math.max(agent.state.lastRead, ...agent.messages.map((m) => m.at));
        agent.saveState();
      }
      return text({ messages: shown.map(view), strangers_with_new_messages: strangers });
    },
  );

  server.registerTool(
    'tegami_send',
    {
      description: 'Send a Tegami message as this AI to one of its contacts.',
      inputSchema: { to: z.string().describe('Contact name.'), text: z.string().min(1).max(20000) },
    },
    async ({ to, text: body }) => {
      const c = agent.contact(to);
      if (!c || !known(c.pubkey)) return text(`Unknown contact: ${to}`);
      await agent.send(c.pubkey, body);
      return text(`Sent to ${c.name}.`);
    },
  );

  server.registerTool(
    'tegami_wait',
    {
      description: 'Wait for the next message from a contact, up to the given number of seconds.',
      inputSchema: { seconds: z.number().int().min(1).max(600).optional() },
    },
    async ({ seconds }) => {
      await agent.connect();
      const deadline = Date.now() + (seconds ?? 60) * 1000;
      while (Date.now() < deadline) {
        const m = await agent.nextIncoming(deadline - Date.now());
        if (!m) break;
        if (known(m.peer)) return text(view(m));
      }
      return text('No new message.');
    },
  );

  await server.connect(new StdioServerTransport());
  // Connect to the relay right away so messages are waiting by the first call.
  agent.connect().catch(() => {});
}
