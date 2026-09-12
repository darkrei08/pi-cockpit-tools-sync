# @darkrei08/pi-cockpit-tools-sync

A native **Pi Agent Framework (`pi.dev`) extension** that reads desktop
[Cockpit Tools](https://github.com/jlcodes99/cockpit-tools) accounts and quotas,
syncs the active OAuth account into Pi, and provisions a multi-account rotator.

## Installation

Install it as a Pi extension:

```bash
pi install npm:@darkrei08/pi-cockpit-tools-sync
```

Or install the standalone GitHub repository:

```bash
pi install github:darkrei08/pi-cockpit-tools-sync
```

## Commands

- `/cockpit-sync`: syncs the active Cockpit Tools account to Pi's
  `~/.pi/agent/auth.json`.
- `/cockpit-provision`: provisions all available Cockpit Tools accounts into
  the `tuxevil-rotator` configuration at `~/.tuxevil-rotator/accounts.json`
  (or `$TUXEVIL_ROTATOR_DIR/accounts.json`).
- `/cockpit-proxy <command>`: runs `tuxevil-rotator` with `status`, `doctor`,
  `import`, or `start`. `start` is launched in the background.

The extension also registers `/cockpit` and `/cockpit-status` for account and
quota status, `/cockpit-accounts` to list accounts, `/cockpit-switch <email>`
to change the active account, and `/cockpit-model [<model>]` to inspect or set
the default Pi model.

## Cockpit Tools data directories

The extension checks these candidate directories in order and uses the first
one containing either marker file `accounts.json` or `account-token.key`:

- `$HOME/.antigravity_cockpit`
- `$HOME/.local/share/cockpit-tools`
- `$HOME/.config/cockpit-tools`
- `$HOME/.wizard-ai/cockpit-tools`
- `$HOME/Library/Application Support/cockpit-tools`
- `$APPDATA/cockpit-tools` (when `APPDATA` is set)
- `$LOCALAPPDATA/cockpit-tools` (when `LOCALAPPDATA` is set)

Account details are read from `accounts/<account-id>.json` below the selected
data directory. If no candidate contains a marker, the default remains
`$HOME/.antigravity_cockpit`.

## Security

- The extension never commits changes.
- Token values are never printed by the extension.
- It reads Cockpit Tools account/quota data and writes only the Pi auth and
  tuxevil-rotator configuration files needed by the commands.
- Existing non-Cockpit rotator accounts are preserved; only entries marked
  `syncedFromCockpit` are replaced during provisioning.

## License

AGPL-3.0-only. The full GNU Affero General Public License v3 text is included
in [`LICENSE`](LICENSE).
