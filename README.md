Use this command to re-deploy the app after changing of codes

`npx wrangler pages deploy public --project-name=r2-file-browser`

## MCP

This site also exposes a read-only MCP server at `/mcp` for other AI agents.

Production URL:

`https://tool-files.patrick-shenzhen.org/mcp`

Cursor / Claude config example:

```json
{
  "mcpServers": {
    "urovo-tools": {
      "url": "https://tool-files.patrick-shenzhen.org/mcp"
    }
  }
}
```

Available tools:

- `search_files` — search files under `tools/` by name; pass a string or an array (`["K329", "SDK"]` is OR)
- `get_file` — get metadata and the public download URL
- `get_description` — get the optional notes for a file
