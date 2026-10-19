# IT Asset Tracker

A small internal web app for tracking which employees have which IT equipment
(laptops, docks, monitors, headsets, and more) and what is in storage.

All data is saved on the server in one shared file, so everyone who opens the
tracker sees and edits the same information. Nothing is saved in the browser,
and nothing is sent outside the company network. The only exception is the
optional low-inventory email, which goes through the company's own mail server.

## What it needs

| Requirement | Details |
|---|---|
| Server | Any internal Windows or Linux server |
| Software | **Node.js 18 or newer** (https://nodejs.org, LTS version) |
| Database | None to install. Data is stored in `data/tracker.json` |
| Network | One port (default **3000**) reachable from the internal network |
| Email (optional) | Address of the company **SMTP relay**, plus a "from" and "to" address |

## Data it stores

Employee names, company, job title, manager, and for each piece of equipment:
model, serial number, asset ID, date assigned, notes, and previous owners.
Please apply the access and backup settings appropriate for that information.

## Folder contents

```
server.js             The back end (serves the page, saves data, sends the email)
public/index.html     The tracker page people use
config.example.json   Settings template. Copy it to config.json and edit
package.json          Lists the one add-on used (nodemailer, for email)
.gitignore            Keeps data, settings, and backups out of Git
data/                 Created automatically. Holds tracker.json (the data)
```

## Install

1. Install Node.js 18+ on the server.
2. Copy this folder to the server, for example `C:\Apps\it-asset-tracker`.
3. Open a command prompt in that folder and run:
   ```
   npm install
   ```
   This installs the email add-on. The tracker runs without it if email is off.
4. Copy `config.example.json` to `config.json` and edit it (see **Settings**).
5. Start it:
   ```
   npm start
   ```
6. Open `http://SERVERNAME:3000` from a work computer.

### Keep it running

`npm start` stops when the window is closed or the server restarts. To run it as
a background service, use whatever your team normally uses, for example:
- Windows: NSSM (`nssm install ITAssetTracker "C:\Program Files\nodejs\node.exe" server.js`,
  with the start folder set to the tracker folder), or the IIS + iisnode / reverse-proxy setup.
- Linux: a `systemd` service running `node server.js`.

## Settings (`config.json`)

| Setting | Meaning |
|---|---|
| `port` | Port the tracker listens on (default 3000) |
| `lowInventory.emailAt` | Send one email when an Inventory tile drops to this number or lower (default 2) |
| `lowInventory.restockedAt` | The tile counts as restocked at this number or more, and starts fresh (default 3) |
| `lowInventory.emailEachDrop` | `true` = another email each time it drops lower after reaching `emailAt` (2, then 1, then 0). `false` = one email only until restocked. (default `true`) |
| `lowInventory.forTile` | Different rules for certain tiles, e.g. `{ "HDMI Cables": { "emailAt": 4, "restockedAt": 6, "emailEachDrop": false } }`. Use the tile's title as it appears on the Inventory page. |
| `email.enabled` | `true` to send low-inventory emails |
| `email.host` / `email.port` | Company SMTP relay, e.g. `smtp.company.com`, port `25` |
| `email.secure` | `true` only if the relay requires SSL on connect (usually port 465) |
| `email.user` / `email.pass` | Leave blank if the relay doesn't require a login |
| `email.from` | Sending address, e.g. an IT notifications mailbox |
| `email.to` | Who receives the alert. Several people: one line, separated by commas, e.g. `"manager.one@company.com, manager.two@company.com"` |
| `email.subject` | Email subject (default `low inventory`) |

Restart the tracker after changing `config.json`.

### How the low-inventory email works
When a tile on the Inventory page (Laptops, Docks, HDMI Cables, and so on) drops to its
`emailAt` number or lower, an email is sent, for example:

    According to our current inventory, we are down to 4 HDMI Cables – 6ft.

The wording uses what's typed in Equipment Type and Model / Description (the model part is
left off if that box is blank). With `emailEachDrop` on, another email goes out each time
that tile drops lower; with it off, the tile stays quiet. Either way it starts fresh once it's
back up to its `restockedAt` number. Several tiles going low at once are combined into one email.
Tiles stay on the Inventory page showing 0 when an item runs out.
If the mail server can't be reached, it retries on the next change.
The rules in use are printed in the window when the tracker starts. While email is turned
off, the window shows what would have been sent.

## Backups

- Back up the `data` folder with the server's normal backups.
- Every save also keeps the previous version as `data/tracker.backup.json`.
- Users can download a copy at any time with **Export Backup** and **Export Inventory**.

## Moving existing data in

Each user who has data in the old single-file tracker:
1. Opens the **old** tracker and clicks **Export Backup**, then
   **Inventory → Export Inventory**.
2. Opens the **new** tracker and clicks **Import Backup** once for each file.

Records with the same ID are replaced by the version in the file.

## Security notes

- There is no login screen. Anyone who can reach the address can view and edit.
  Limit access with firewall rules, or put it behind IIS / a reverse proxy with
  Windows Authentication if only certain people should use it.
- Never commit `data/`, `config.json`, or backup `.json` files to Git.
  `.gitignore` blocks them.
- Use a **private** repository owned by the company, never a public one.
