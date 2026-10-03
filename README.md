# Telecallers Lead — Vercel + MongoDB Atlas

A shared lead list for a telecalling team. Leads are organised into **folders**, everyone with the link can call, WhatsApp and update call status, and an admin (with a password you choose) can import, edit, move and delete leads and folders.

- **Hosting:** Vercel (free Hobby plan) — static page in `public/` plus one serverless function in `api/`.
- **Database:** MongoDB Atlas **M0** free cluster — a JSON document database with **512 MB free forever**, no credit card needed. Every lead is stored as a JSON document, so you can browse and export your data directly in Atlas.

512 MB is far more than this app needs: the 722 sample leads take well under 1 MB, so the free tier holds hundreds of thousands of leads.

## Project layout

```
public/            The web app (index.html + browser modules)
api/lead-data.js   The single Vercel Function; vercel.json routes every /api/* path to it
server/lib/        Lead, folder (compartment) and admin-session logic + storage adapters
server/data/       The original 722 leads, loaded into the database on first run
scripts/           Local development server
vercel.json        Vercel build, routing and function settings
```

## Step 1 — Create the free MongoDB Atlas database

1. Sign up at [mongodb.com/cloud/atlas/register](https://www.mongodb.com/cloud/atlas/register) (Google sign-in works).
2. Choose **Create cluster → M0 (Free)**. For provider/region pick **AWS → Mumbai (ap-south-1)**. That matches the Vercel region in `vercel.json` (`bom1`, Mumbai), so imports stay fast. If you pick another region, change `"regions"` in `vercel.json` to the closest Vercel region.
3. **Database Access → Add New Database User:** choose a username and an auto-generated password (letters and digits only avoid URL-encoding problems). Role: *Read and write to any database*.
4. **Network Access → Add IP Address → Allow access from anywhere** (`0.0.0.0/0`). Vercel functions don't use fixed IP addresses, so this is required. The database user and password still protect the data.
5. **Database → Connect → Drivers** and copy the connection string. It looks like:
   `mongodb+srv://USER:PASSWORD@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`
   Replace `<db_password>` with the user's real password.

The app creates the `leadsevolynflow` database and `lead_store` collection automatically on first use.

> Shortcut: in Vercel you can also add MongoDB Atlas from **Storage / Marketplace → MongoDB Atlas**. It creates a free cluster and sets the connection variable for you (`MONGODB_URI`, or a prefixed name like `STORAGE_MONGODB_URI`; both work). You still need to set `LEAD_ADMIN_PASSWORD` yourself.

## Step 2 — Deploy to Vercel

1. Push this repository to GitHub (it already is if you're reading this there).
2. At [vercel.com/new](https://vercel.com/new), import the repository. Leave **Framework Preset: Other** and leave the build and output settings alone. `vercel.json` already sets the output to `public/`.
3. Under **Environment Variables**, add:

   | Name | Value | Required |
   |---|---|---|
   | `MONGODB_URI` | The Atlas connection string from Step 1. If you connected Atlas through Vercel **Storage**, a prefixed name such as `STORAGE_MONGODB_URI` works as-is | Yes |
   | `LEAD_ADMIN_PASSWORD` | **The admin password you choose** | Yes |
   | `LEAD_SESSION_SECRET` | A random string of 32+ characters | Optional |
   | `SEED_INITIAL_LEADS` | `false` to start with no sample leads | Optional |
   | `MONGODB_DB` / `MONGODB_COLLECTION` | Override the database or collection name | Optional |

4. Click **Deploy**. When it finishes, open `https://your-project.vercel.app/api/health`. You should see `{"ok":true,"storage":"mongodb","adminConfigured":true}`.

If the health check reports *Database is not configured*, `MONGODB_URI` is missing. If it reports *Shared storage is temporarily unavailable*, check the function logs in Vercel (**Deployments → your deployment → Functions/Logs**). The usual causes are a wrong password in the URI or a missing `0.0.0.0/0` network rule.

Generate a session secret (optional) with:

```bash
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
```

Never put real secrets in `public/`, `vercel.json`, `.env.example` or Git.

### Changing the admin password

Edit `LEAD_ADMIN_PASSWORD` in **Vercel → Project → Settings → Environment Variables**, then **Redeploy** (environment changes apply to new deployments only).

- If `LEAD_SESSION_SECRET` is **not** set, changing the password also signs every admin out immediately.
- If it **is** set, existing 24-hour admin sessions remain valid until logout or expiry. Rotate `LEAD_SESSION_SECRET` to sign everyone out.

## Using the app

### Everyone with the link can

- Browse folders in the left sidebar (a horizontal strip on phones), or open **All Leads**.
- Search, filter by call status (tap a status chip such as *Interested* or *Follow-up*), filter by City and Category, and sort by Area A–Z / Z–A.
- Use **Call** and **WhatsApp** on each lead. The WhatsApp message template is saved in each browser.
- Change status, remarks, and follow-up and press **Update**. The change is saved to the database, so it stays after a refresh and shows on every other phone or computer.

### Admin (after **Admin Login**)

- **Import Leads** into any folder (or create one in the import dialog). You can drop a `.json` file onto the upload area, choose one, or paste JSON. Select **Preview JSON**, review the rows, then **Import Valid Leads**.
- **Folders:** the sidebar's **＋ New** or **Manage Folders** creates folders. When a folder is open, its header has **Import here**, **Download**, **Rename** and **Delete**.
- **Move leads:** open a folder, tick a lead, Shift-click another to select a range, choose the destination in the dark bar and press **Move**. Status, remarks and follow-up move with the lead.
- **Edit Lead / Delete Lead** on any card.
- **Download JSON Backup** saves every lead. A folder's **Download** saves just that folder in a format you can import again.

Deleting a folder permanently deletes every lead inside it. You must type the folder's exact name, and the dialog offers **Download JSON First**.

## Import JSON format

One lead:

```json
{
  "name": "Example Business",
  "mobile": "9876543210",
  "address": "Agra, Uttar Pradesh",
  "city": "Agra",
  "category": "Jewelry store",
  "status": "Not Called",
  "followup": "",
  "remarks": ""
}
```

For several leads, upload an array of these objects. `name` and `mobile` are required. `city` is derived from the address when omitted. `sno` is optional; the next free serial number is assigned automatically. Status must be one of *Not Called, Called, No Answer, Follow-up, Interested, Not Interested*. Up to 1,000 leads / 2 MB per import; split bigger files.

The importer also accepts the display labels `S.No.`, `Institute/Business Name`, `Mobile Number`, `Area/Address`, `City`, `Category`, `Call Status`, `Next Follow-up` and `Remarks`. This is exactly the format of a folder **Download**. Keep mobile numbers in quotes so leading zeroes are preserved.

## Moving your data from the old Netlify site

The new deployment starts with the original 722 leads in **Existing Leads**. To bring over work done on Netlify (statuses, remarks, imported folders):

1. Before deploying, set `SEED_INITIAL_LEADS=false` in Vercel if you plan to import *Existing Leads* from Netlify. This avoids duplicate sample leads.
2. On the **old Netlify site**, log in as admin, open **Manage Compartments**, and press **Download** for each compartment.
3. On the **new Vercel site**, log in, create a folder with the same name, open **Import Leads**, choose that folder and upload the downloaded file. Status, remarks, and follow-up come across with each lead.

Also keep a full **Download JSON Backup** from Netlify as an archive before shutting the old site down.

## Local development

Requires Node.js 22.

```bash
npm install
npm test          # runs the full test suite
npm run dev       # http://localhost:3000
```

Without `MONGODB_URI`, `npm run dev` stores data in `.data/local-store.json` and uses the admin password `admin` unless you set `LEAD_ADMIN_PASSWORD`. To develop against Atlas, copy `.env.example` to `.env` and fill in the values. `.env` is git-ignored.

Opening `public/index.html` directly from disk will not work. Browsers block its JavaScript modules there, and there is no API behind it.

## Free-tier notes

- **MongoDB Atlas M0:** free forever with 512 MB of storage and shared CPU. Atlas may pause a free cluster after a long period with no connections (it emails you first). Resuming it from the Atlas dashboard keeps all data.
- **Vercel Hobby:** free for personal, non-commercial projects, with generous limits for a small team's lead list. For commercial use, Vercel's terms require the Pro plan.
- Every lead is its own JSON document, so changes to different leads never overwrite each other. If two people edit the same field at the same moment, the last save wins.
- Status, remarks, and follow-up are public to anyone with the link by design. Don't use this site for data that must be private from link holders.
- The admin login is rate-limited (5 attempts per 15 minutes per IP per server instance). Choose a strong password.
