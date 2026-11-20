# Shopee Coins Daily Check-in for Shopee Taiwan (Chrome extension)

Checks in on the **Shopee Taiwan (shopee.tw) daily coins page** for you every day, so you never miss a day of the 7-day coin streak. If Shopee has logged you out, it **logs back in with your Google account** automatically. No passwords are stored.

<p align="center"><img src="icons/icon128.png" width="96" alt="icon"></p>

> This extension is for **shopee.tw** only. It works whether your Shopee site language is Traditional Chinese or English.

## Features

- **Daily check-in at 00:02**: opens the [Shopee Coins page](https://shopee.tw/shopee-coins) in a background tab, presses the daily check-in button, and closes the tab
- **Retries if it fails**: if the 00:02 try did not work (or Chrome was closed at that time), it tries again every hour, up to 3 times
- **Catches up when Chrome starts**: every time Chrome starts it gets another round of 3 tries (right away, then hourly), so a PC that was off at midnight still checks in
- **Stops for the day once done**: after a successful check-in (or when the page already says "come back tomorrow") nothing runs again until the next day
- **Logs back in with Google**: when the page shows "log in to get coins", it opens Shopee's login page, presses **Google**, picks your Google account and presses **Continue**, then checks in
- Toolbar badge: green ✓ = checked in today, red ! = the last try failed; the popup shows recent activity
- Does **not** keep Chrome running in the background. When Chrome is closed, nothing runs

## What's included

| Part | Required? | What it does |
|---|---|---|
| Chrome extension (files in the root folder) | ✅ Required | The part that actually checks in |
| [`boot-launcher/`](#optional-open-chrome-at-windows-startup) | Optional | At Windows sign-in, opens Chrome only if today's check-in is not done yet |

## Install the extension

1. Download this project (green **Code** button → **Download ZIP**) and unzip it
2. Open `chrome://extensions` in Chrome
3. Turn on **Developer mode** (top right)
4. Click **Load unpacked** and choose the unzipped folder (the one that contains `manifest.json`)
5. Click the puzzle icon in the toolbar → pin "Shopee Daily Check-in"
6. Make sure you are logged in to [shopee.tw](https://shopee.tw) in this Chrome
7. Click the icon → **Check in now** to try it once

## Popup

- Today's status and the last 10 results
- **Check in now**: runs a check-in right away
- **Log back in with Google when logged out**: on by default; untick it if you don't want automatic re-login
- **Google account**: only needed if this Chrome has several Google accounts. Enter the one you use for Shopee; with a single account it is picked automatically
- **Support me on Ko-fi** button

## About the automatic Google login

- It only clicks **the account** and **Continue**. If Google asks for a **password, 2-step verification or a robot check**, it stops and the popup tells you to log in once yourself. Passwords are never typed or stored
- It only works if you normally log in to Shopee with Google and this Chrome is signed in to that Google account
- To let the Google login popup open, the extension allows pop-ups for `shopee.tw` (Chrome settings → Privacy and security → Site settings → Pop-ups and redirects)
- The Google popup is a normal window, so you may see it for a few seconds

## Status meanings

| Status | Meaning |
|---|---|
| Checked in | Pressed the button and the page now says "come back tomorrow" |
| Already checked in today | The page already showed the done state |
| Clicked check-in but could not confirm it | Usually fine; the next hourly try normally shows "already checked in" |
| Logged back in to Shopee with Google | Automatic re-login worked; a check-in result follows |
| You need to log in to Shopee | Automatic re-login is off, or the page still shows "logged out" after logging in |
| Could not log back in with Google / Google needs you | Log in to Shopee once yourself |
| Shopee asks for verification | Shopee shows a puzzle or other human check. Open the coins page and handle it yourself; the extension never tries to solve these |
| Check-in button not found | Shopee may have changed its page; the matching rules in `background.js` → `checkIn()` need an update |

## Optional: open Chrome at Windows startup

The [`boot-launcher`](boot-launcher/) folder is a small Windows tool that you **may or may not install**.

**What it does:** the extension only runs while Chrome is open. This tool runs every time you sign in to Windows and **first checks whether today's check-in is already done**:
- Not done yet → opens Chrome with the profile you chose (minimized by default) so the extension can check in
- Already done (for example the 00:02 check-in worked) → **does not open Chrome**, so it won't bother you
- The same Chrome profile is already open → does not open another window

### With vs. without the startup launcher

| | Without (extension only) | With the startup launcher |
|---|---|---|
| Daily check-in at 00:02 | ✅ If Chrome is open at that time | ✅ If Chrome is open at that time |
| PC was off at midnight | Checks in when you open Chrome yourself | Opens Chrome for you at sign-in and checks in |
| Does Chrome pop up at startup when today is already done? | No | No (it sees today is done and skips) |
| Best for | People who open Chrome every day anyway | People who often go a day without opening Chrome |
| Setup | None | Double-click 3 files (steps below) |
| What it changes on your PC | Nothing | Adds one shortcut to the Windows Startup folder (remove it any time) |

### Setup (double-click in this order)

| File | What it does |
|---|---|
| `1_select_chrome_profile.bat` | Lists every Chrome profile on this PC; type the number of **the one with this extension installed** |
| `2_test_open.bat` | Opens Chrome once with that profile so you can confirm it is the right one |
| `5_check_status.bat` | Only shows today's status and whether Chrome would be opened at startup; does not open Chrome |
| `3_install_startup.bat` | Creates a shortcut in the Windows Startup folder so it runs at every sign-in |
| `4_remove_startup.bat` | Removes that shortcut if you no longer want it |

Settings are in `boot-launcher/settings.txt`:

| Setting | Default | Meaning |
|---|---|---|
| `account=` | (empty) | Which Chrome profile to open; filled in automatically by `1_select_chrome_profile.bat` |
| `window=` | `minimized` | `minimized` = start minimized to the taskbar; `normal` = normal window |
| `delay_seconds=` | `20` | Seconds to wait after sign-in before deciding (lets the network connect) |
| `skip_if_done=` | `yes` | Set to `no` to open Chrome at every startup |

The launcher writes what it did to `boot-launcher/startup.log`.

### How it knows whether today is done

The extension writes "checked in today?" to `Downloads\ChromeExtensionStatus\shopee_checkin.json`:

```json
{ "lastDone": "2026-11-21", "updated": "2026-11-21 00:02:40" }
```

You can change where it is saved with `statusDir` in the extension's `status_config.json` (a path relative to Chrome's download folder). For example, if the extension is in `Downloads\tools\shopee`, set `"statusDir": "tools/shopee"` to keep the status file inside the extension folder; the startup launcher reads the same setting. The download bar is turned off while the file is saved and the entry is removed from the download history, so you won't see a download prompt. If you don't use the startup launcher, this small file does no harm.

> The startup launcher only reads Chrome's profile list and this status file on your own PC. It does not connect to the internet and does not read your passwords or cookies.

## Permissions

| Permission | Why |
|---|---|
| `https://shopee.tw/*` | Open the coins page, read the check-in button and click it; use the login page |
| `https://accounts.google.com/*` | Pick your account and press Continue in Google's login popup |
| `tabs`, `scripting` | Open a background tab and run the check inside the page |
| `alarms` | The 00:02 check-in and the hourly retry |
| `storage` | Remember today's status, recent activity and your settings |
| `contentSettings` | Allow pop-ups on shopee.tw so the Google login popup can open |
| `downloads`, `downloads.ui` | Save the status file above (and hide the download prompt while saving) |

Your passwords, cookies and data are never read or sent to any outside server.

## Notes

- It works by reading text and buttons on the Shopee page. On shopee.tw the check-in box shows Traditional Chinese text even when the site is in English, so Chinese text is matched first and English is a fallback. A Shopee redesign may need an update.
- The time zone of your PC decides when "today" starts; it should be set to Taiwan time (UTC+8).
- Pressing **Check in now** also counts as one of the 3 tries.
- Using automation tools may not comply with Shopee's terms of service; use at your own risk.
- Not affiliated with or endorsed by Shopee or Google. Shopee and Google are trademarks of their respective owners.

## Support

If this saves you time, you can buy me a coffee ☕ → [ko-fi.com/sagiriben](https://ko-fi.com/sagiriben)
