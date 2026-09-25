# Telecaller Leads — Netlify Deployment

This folder is a complete Netlify site for a shared telecaller lead list. Netlify Blobs stores full lead records separately from `index.html`, so successful changes remain after a refresh, on another device, and after later deployments.

## Permissions

Anyone with the site link can:

- View, search, and filter leads.
- Use the Call and WhatsApp buttons.
- Update status, remarks, and follow-up date with the existing **Update** button.

The shared admin password is required to:

- Import one lead or multiple leads from JSON.
- Edit core lead details.
- Delete leads.
- Download a JSON backup.

## Install and test

Install a supported Node.js LTS release (Node 20 or 22), then run:

```powershell
npm install
npm test
```

Do not double-click `index.html` to run the app. Browser security blocks its JavaScript modules in that mode, and there is no Netlify Function or Blob storage behind a local file. For local development, use `npx netlify-cli dev`; on Windows, use Node 20 or 22 LTS rather than an odd-numbered Node release.

## Required environment variables

Configure these server-only values in Netlify under **Site configuration → Environment variables**:

- `LEAD_ADMIN_PASSWORD`: the strong shared password used by the two administrators.
- `LEAD_SESSION_SECRET`: an independent random signing secret with at least 32 characters.

Generate a suitable session secret with:

```powershell
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
```

Do not put real secrets in `index.html`, `netlify.toml`, `.env.example`, or Git. For local testing only, copy `.env.example` to an untracked `.env` file and add development values there.

## Deploy to Netlify

Git-based deployment is recommended because this project includes a bundled Function:

1. Place this folder in a GitHub, GitLab, or Bitbucket repository.
2. In Netlify, choose **Add new project** and import the repository.
3. Leave the build command empty; `netlify.toml` publishes the project root and bundles `netlify/functions`.
4. Add both required environment variables.
5. Deploy the site.

For command-line deployment:

```powershell
npx netlify-cli login
npx netlify-cli init
npx netlify-cli deploy --build --prod
```

Do not use Netlify's plain drag-and-drop uploader. It does not provide the Function build and environment configuration this site requires.

## Initial data

The original 722 leads are stored in `netlify/data/initial-leads.json`. On the first API request, the Function copies them into Netlify Blobs and writes a one-time initialization marker. Later deployments do not recreate deleted leads.

If an older version of this site already saved status, remarks, or follow-up values under the previous Blob keys, the first migration carries those values into the full records.

## Import Leads from JSON

1. Open the deployed site and select **Admin Login**.
2. Enter `LEAD_ADMIN_PASSWORD`.
3. Select **Import Leads**.
4. Paste JSON or upload a `.json` file.
5. Select **Preview JSON**, review valid rows and errors, then select **Import Valid Leads**.

If **Admin Login** does nothing and the page remains on **Loading shared updates...**, the JavaScript module did not load. Confirm that you are using the deployed `https://...netlify.app` URL and that the entire project was deployed—not only `index.html`.

A single lead can use this format:

```json
{
  "name": "Example Business",
  "mobile": "9876543210",
  "address": "Agra, Uttar Pradesh",
  "category": "Jewelry store",
  "status": "Not Called",
  "followup": "",
  "remarks": ""
}
```

Upload multiple leads as an array of objects. `name` and `mobile` are required. `sno` is optional; the server assigns the next unused serial number when it is omitted. Status, follow-up, and remarks receive safe defaults when omitted.

The importer also accepts the display labels `S.No.`, `Institute/Business Name`, `Mobile Number`, `Area/Address`, `Category`, `Call Status`, `Next Follow-up`, and `Remarks`. These map to the lowercase fields shown above. Keep mobile numbers in quotation marks so leading zeroes are preserved. If a row contains both versions of one field, their values must match.

## Backup and password changes

After admin login, select **Download JSON Backup** to save the current lead collection.

- Changing `LEAD_ADMIN_PASSWORD` changes the password used for future logins. Existing 24-hour admin sessions remain active until logout or expiry.
- Rotating `LEAD_SESSION_SECRET` immediately invalidates every existing admin session. Use this when the password may have been shared unintentionally.

Redeploy after changing environment variables if Netlify does not automatically rebuild the site.

## Verify shared persistence

1. Open the deployed site in one browser.
2. Wait for **Shared lead data loaded**.
3. Change a lead's status, remarks, or follow-up and select **Update**.
4. Wait for the saved confirmation.
5. Refresh the page and confirm the values remain.
6. Open the site on another browser or phone and confirm it shows the same values.

If an update fails, the typed values remain visible and the card reports that the update should be retried. The interface never reports a change as saved before Netlify confirms it.

## Operational notes

- The WhatsApp message template remains a browser-local preference.
- Public workflow updates are intentional; do not use this site for lead data that should be private from anyone holding the link.
- Each lead is a separate Blob record, so changes to different leads do not overwrite each other.
- If two users change the same field at nearly the same time, the last successful write wins.
- Monitor usage in Netlify's billing dashboard. Two users and a few similar low-traffic projects should be modest, but a public URL can still be abused.
