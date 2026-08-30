/**
 * The product set: one page per MCP client that can connect to NUM.
 *
 * This is programmatic SEO pointed at NUM itself rather than at 77 cities, and
 * it is a better fit for the method than the city guides are. The pSEO guide's
 * core pattern is "[head term] for [modifier]", and it warns that the failure
 * case is pages where only the modifier changes. Here the modifier changes
 * something real: every one of these clients keeps its MCP configuration in a
 * different file, in a different shape, and a developer searching "connect X
 * to <client>" is asking a question whose answer genuinely differs per client.
 *
 * The intent is also the sharpest NUM has. Somebody typing that query is
 * building an agent, has a token in hand, and is four minutes from a working
 * integration. Compare a traveller searching for beaches, who is months from
 * a booking and may never be in Thailand at all.
 *
 * ── the honesty problem, and how it is handled
 *
 * Client config formats move. A page that confidently states a wrong file path
 * costs more than it earns, so every entry carries `checked` (when this was
 * last verified) and `docs` (the vendor's own page), both of which are
 * PRINTED — and every page says plainly that if the client has moved its
 * config, the two things that never change are the URL and the bearer token.
 * That sentence is the difference between a page that ages into a liability
 * and one that ages into a slightly-out-of-date-but-still-useful reference.
 */

export const MCP_URL = 'https://itsnum.com/mcp';
export const SIGNUP = 'https://itsnum.com/api/agent/signup';
export const CHECKED = '2026-08-29';

const json = (o) => JSON.stringify(o, null, 2);

/** The remote-HTTP block most clients want, under whatever key they call it. */
const httpBlock = (key = 'mcpServers', typeField = 'type') => json({
  [key]: {
    num: {
      [typeField]: 'http',
      url: MCP_URL,
      headers: { Authorization: 'Bearer numa_live_...' },
    },
  },
});

export const CLIENTS = Object.freeze([
  {
    slug: 'claude-desktop',
    name: 'Claude Desktop',
    vendor: 'Anthropic',
    docs: 'https://modelcontextprotocol.io/docs/develop/connect-local-servers',
    lede: 'Claude Desktop connects to a remote MCP server as a custom connector rather than through the config file — the config file is for servers that run on your own machine.',
    steps: [
      'Settings → Connectors → Add custom connector.',
      `Paste ${MCP_URL} as the URL.`,
      'Give it the name "num", and add your token as the Authorization header: <code>Bearer numa_live_…</code>',
      'Start a new chat. Claude will ask before it calls a NUM tool the first time.',
    ],
    config: null,
    note: 'NUM is a remote server, so nothing installs and nothing runs locally. If your build of Claude Desktop has no Connectors panel, it predates remote MCP support — update it.',
  },
  {
    slug: 'claude-code',
    name: 'Claude Code',
    vendor: 'Anthropic',
    docs: 'https://docs.claude.com/en/docs/claude-code/mcp',
    lede: 'One command. Claude Code stores remote MCP servers per project or per user, and NUM is a plain HTTP server, so there is nothing to install.',
    lang: 'bash',
    config: `claude mcp add --transport http num ${MCP_URL} \\\n  --header "Authorization: Bearer numa_live_..."`,
    steps: [
      'Run the command above in your project.',
      'Check it with <code>claude mcp list</code> — num should report as connected.',
      'Add <code>--scope user</code> to make it available in every project rather than this one.',
    ],
  },
  {
    slug: 'cursor',
    name: 'Cursor',
    vendor: 'Anysphere',
    docs: 'https://cursor.com/docs/context/mcp',
    lede: 'Cursor reads MCP servers from a JSON file — one for the project, one for you.',
    file: '.cursor/mcp.json (this project) or ~/.cursor/mcp.json (everywhere)',
    config: httpBlock(),
    steps: [
      'Create the file if it does not exist and paste the block above.',
      'Settings → MCP. The num server should appear with its five tools listed.',
      'If the toggle is off, turn it on — Cursor disables new servers until you approve them.',
    ],
  },
  {
    slug: 'vs-code',
    name: 'VS Code',
    vendor: 'Microsoft',
    docs: 'https://code.visualstudio.com/docs/copilot/customization/mcp-servers',
    lede: 'GitHub Copilot in agent mode reads MCP servers from a workspace file. Note the key is <code>servers</code>, not <code>mcpServers</code> — this is the single most common reason a working config copied from another client does nothing here.',
    file: '.vscode/mcp.json',
    config: httpBlock('servers'),
    steps: [
      'Create <code>.vscode/mcp.json</code> and paste the block above.',
      'Open Copilot Chat and switch to Agent mode.',
      'Click the tools icon; num\'s five tools should be listed and tickable.',
    ],
  },
  {
    slug: 'windsurf',
    name: 'Windsurf',
    vendor: 'Codeium',
    docs: 'https://docs.windsurf.com/windsurf/cascade/mcp',
    lede: 'Windsurf keeps its MCP servers in Cascade\'s own config file.',
    file: '~/.codeium/windsurf/mcp_config.json',
    config: json({
      mcpServers: {
        num: { serverUrl: MCP_URL, headers: { Authorization: 'Bearer numa_live_...' } },
      },
    }),
    steps: [
      'Paste the block into the config file.',
      'Open Cascade → the MCP panel → Refresh.',
    ],
    note: 'Windsurf has used both a serverUrl field and a url field across versions. If one does not connect, try the other — the address and the token are the parts that matter.',
  },
  {
    slug: 'cline',
    name: 'Cline',
    vendor: 'Cline',
    docs: 'https://docs.cline.bot/mcp/configuring-mcp-servers',
    lede: 'Cline stores its servers in a settings file you can open from inside the extension.',
    file: 'cline_mcp_settings.json — open it from the MCP Servers panel',
    config: httpBlock(),
    steps: [
      'MCP Servers → Configure → paste the block.',
      'The server appears in the list; expand it to see the five tools.',
    ],
  },
  {
    slug: 'zed',
    name: 'Zed',
    vendor: 'Zed Industries',
    docs: 'https://zed.dev/docs/ai/mcp',
    lede: 'Zed calls them context servers, and they live in your normal settings file.',
    file: '~/.config/zed/settings.json',
    config: json({
      context_servers: {
        num: { source: 'custom', url: MCP_URL, headers: { Authorization: 'Bearer numa_live_...' } },
      },
    }),
    steps: [
      'Add the block to your settings and save.',
      'Open the agent panel; num should be listed under tools.',
    ],
  },
  {
    slug: 'chatgpt',
    name: 'ChatGPT',
    vendor: 'OpenAI',
    docs: 'https://platform.openai.com/docs/mcp',
    lede: 'ChatGPT connects to a remote MCP server as a connector. There is no config file — you add the URL in settings, and availability depends on your plan.',
    config: null,
    steps: [
      'Settings → Connectors → Advanced → Developer mode, and enable it.',
      `Add a connector pointing at ${MCP_URL}.`,
      'Authenticate with your token, then pick num from the tools menu in a chat.',
    ],
    note: 'Custom MCP connectors are not on every ChatGPT plan, and OpenAI has moved this setting more than once. If the panel is not there, the API path works regardless — see the OpenAPI spec.',
  },
  {
    slug: 'n8n',
    name: 'n8n',
    vendor: 'n8n',
    docs: 'https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.toolmcp/',
    lede: 'n8n reaches an MCP server through the MCP Client Tool node, which you attach to an AI Agent node — so NUM becomes a tool inside a workflow rather than a chat.',
    config: null,
    steps: [
      'Add an <b>MCP Client Tool</b> node and connect it to your AI Agent node.',
      `Set the endpoint to ${MCP_URL} and the transport to HTTP.`,
      'Add a Bearer Auth credential holding your <code>numa_live_</code> token.',
      'Pick which of the five tools the agent may call — the write tools are unmetered, the read tools are not.',
    ],
  },
  {
    slug: 'librechat',
    name: 'LibreChat',
    vendor: 'LibreChat',
    docs: 'https://www.librechat.ai/docs/features/mcp',
    lede: 'LibreChat declares MCP servers in its YAML config, alongside everything else it runs.',
    file: 'librechat.yaml',
    lang: 'yaml',
    config: `mcpServers:\n  num:\n    type: streamable-http\n    url: ${MCP_URL}\n    headers:\n      Authorization: "Bearer numa_live_..."`,
    steps: [
      'Add the block to <code>librechat.yaml</code>.',
      'Restart LibreChat.',
      'The tools appear in the agent builder.',
    ],
  },
]);

export const bySlug = (slug) => CLIENTS.find((c) => c.slug === slug) ?? null;
