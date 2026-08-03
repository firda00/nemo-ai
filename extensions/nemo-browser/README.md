# Nemo Browser Extension v1

Chrome Manifest V3 extension for supervised, read-only marketplace observation.

## Current boundary

- Works only on `https://uzum.uz/*` and `https://seller.uzum.uz/*`.
- Reads the active, user-selected tab only after the owner presses the observe button.
- Does not request cookies, passwords, clipboard, downloads, or access to other Chrome pages.
- Does not fill forms, submit actions, publish, purchase, or pay.

## Local installation

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this `extensions/nemo-browser` directory.
5. Open a supported Uzum page, click the Nemo extension icon, then use **Подключить текущую вкладку**.

The next phase sends an explicit observation to the Nemo account, stores an audit event, and adds owner-approved write actions.
