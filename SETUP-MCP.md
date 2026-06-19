# Setting up RepoRose MCP Server

This guide shows how to connect RepoRose to Claude Desktop (or any MCP client) so you can analyze repositories directly from your AI assistant.

## What is MCP?

MCP (Model Context Protocol) lets Claude Desktop call RepoRose as a tool. You can ask Claude things like:

- "Analyze this repository and tell me about its architecture"
- "What files depend on src/core/scanner.js?"
- "Search for files related to authentication"

## Claude Desktop Setup

### 1. Find your config file

**macOS:**
```bash
~/Library/Application Support/Claude/claude_desktop_config.json
```

**Windows:**
```bash
%APPDATA%/Claude/claude_desktop_config.json
```

**Linux:**
```bash
~/.config/Claude/claude_desktop_config.json
```

### 2. Add RepoRose to the config

Edit the file and add this inside the `mcpServers` object:

```json
{
  "mcpServers": {
    "reporose": {
      "command": "reporose",
      "args": ["mcp"]
    }
  }
}
```

If you installed RepoRose locally (not via `npm install -g`), use the full path:

```json
{
  "mcpServers": {
    "reporose": {
      "command": "/path/to/RepoRose/bin/cli.js",
      "args": ["mcp"]
    }
  }
}
```

### 3. Restart Claude Desktop

Fully quit and reopen Claude Desktop. You should see RepoRose tools appear in the tool list.

## Available Tools

Once connected, Claude can use these tools:

| Tool | Description |
|------|-------------|
| `analyze` | Scan a repository and build the map.json |
| `get_map` | Get the full map.json for a project |
| `search_files` | Search for files by name or content |
| `get_file` | Get detailed info about a specific file |
| `get_dependencies` | Show what a file depends on / what depends on it |

## Testing It Works

Ask Claude something like:

> "Please analyze the repository at /path/to/my-project and tell me what the main entry point is."

Or:

> "Use reporose to search for files related to 'authentication' in /path/to/my-project"

## Troubleshooting

### "reporose: command not found"

Make sure `reporose` is in your PATH, or use the full path to the CLI:
```bash
which reporose  # see where it is
```

### MCP server crashes immediately

Check that RepoRose works standalone:
```bash
reporose help
reporose mcp  # should hang (waiting for JSON-RPC), Ctrl+C to exit
```

### Claude doesn't see the tools

1. Check the JSON syntax in your config file (trailing commas will break it)
2. Make sure you fully restarted Claude Desktop (not just closed the window)
3. Check Claude's logs for errors

## Cursor / Other MCP Clients

The same config works for Cursor and other MCP-compatible clients. Check their docs for the exact config file location, but the JSON format is the same.

For Cursor:
- **macOS**: `~/.cursor/mcp.json`
- **Windows/Linux**: Check Cursor settings → MCP

## Security Note

The MCP server runs with the same permissions as your user. It can:
- Read any file you can read
- Execute `reporose analyze` on any directory

Make sure you trust the AI client before enabling MCP tools.
