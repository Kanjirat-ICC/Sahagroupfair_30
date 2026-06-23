# Amplify + Google Sheets Setup

## Google Sheet

Create a spreadsheet and share it with the Google service account email.

The app will create missing tabs and seed default stock when the service account has edit access. If you create the tabs manually, use these headers:

`Members`

```csv
timestamp_iso,time_th,member_id,product,spin_id
```

`Stock`

```csv
product,qty,updated_at
```

## Amplify Environment Variables

Set these in Amplify before deploying:

```text
GOOGLE_SHEET_ID=...
GOOGLE_CLIENT_EMAIL=...
GOOGLE_PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n
ADMIN_PASSWORD=...
SESSION_SECRET=...
ALLOW_LEGACY_SAVE=false
```

Use the service account JSON key values for `GOOGLE_CLIENT_EMAIL` and `GOOGLE_PRIVATE_KEY`.
Keep `ALLOW_LEGACY_SAVE=false` so old cached clients cannot write client-selected prizes.

## Local Smoke Test

Use the in-memory Sheets mock when Google credentials are not available:

```sh
SHEETS_MOCK=true ADMIN_PASSWORD=testpass SESSION_SECRET=testsecret npm start
```

Build the Amplify bundle locally:

```sh
npm ci
npm run build:amplify
```
