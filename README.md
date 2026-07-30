# @pipeworx/in-bmv

Indiana DMV data: **Bureau of Motor Vehicles (BMV)** branches, self-service kiosks, BMV Connect
locations, motorcycle rider-training (RSI) courses and skills-test sites. Keyless.

## What Indiana calls its DMV

Indiana's agency is the **Bureau of Motor Vehicles**, universally the **BMV**. Hoosiers say
"BMV branch" where other states say "DMV office", so the tool description names both.

## Tools

| Tool | What it returns |
|---|---|
| `in_bmv_branches` | Address, phone, hours, coordinates, kiosk flag and rider-training courses for all 160 published locations |

Filters: `city`, `name`, `zip`, `location_type`, `kiosk_only`, `limit`.

## Auth

None. The source is a plain static JSON file on `in.gov` — no key, no query parameters, no
rate limit to negotiate. The whole file is fetched and filtered in code.

## Location type is the main axis of this data

One file covers six categories, which is unusual — most states publish only their staffed
offices. Live counts as of 2026-07-30:

| `typeLabel` | Count |
|---|---|
| BMV Branch + Kiosk | 60 |
| BMV Branch | 56 |
| RSI Training Course & Skills Test | 22 |
| BMV Connect Location | 11 |
| RSI Training Course | 10 |
| Skills Test | 1 |

`location_type` accepts those exact labels and also plain words — `"branch"`, `"kiosk"`,
`"connect"`, `"motorcycle"`, `"rider training"`, `"skills test"`. `kiosk_only: true` is the
separate `hasKiosk` flag and keeps **72 of the 160** (the 60 "Branch + Kiosk" plus the
11 BMV Connect kiosks and one more).

## Gotchas worth knowing

These are live-verified behaviours, not guesses:

- **`website` is an empty string on 127 of 160 rows**, not null. The tool normalises `""` to
  `null` so a caller can test for absence instead of comparing against the empty string.
- **`hours` is null on 43 rows.** RSI training courses and skills-test sites are run by partner
  organisations (ABATE of Indiana, Harley dealers) that schedule by appointment rather than
  posting counter hours; the tool leaves those null rather than inventing a schedule.
- **`url` on an RSI row points at the partner**, not at in.gov.
- **No county column.** Indiana's branch map keys off coordinates, so `county` comes back null.
- **ZIPs are sometimes ZIP+4** (`46203-6063`). The `zip` filter is a prefix match, so a
  five-digit ZIP still matches.
- **RSI rows are not branches.** A city filter like `"Indianapolis"` returns 12 locations, and
  several are motorcycle-training sites — use `location_type="branch"` when the caller wants a
  place to renew a licence.

## Data sources

- [in.gov BMV branch map](https://www.in.gov/bmv/branch-locations-and-hours/bmv-branch-map/) —
  `bmv-branchmap-locations.json`

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "in-bmv": {
      "url": "https://gateway.pipeworx.io/in-bmv/mcp"
    }
  }
}
```

Or connect to the full Pipeworx gateway for access to all 1392+ data sources:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English:

```
ask_pipeworx({ question: "your question about Indiana BMV data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [All tools and guides](https://github.com/pipeworx-io/examples)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
