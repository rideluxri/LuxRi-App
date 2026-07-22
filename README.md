# LuxRi Driving Services — deployment guide

This is your booking app as a real, standalone website (not a Claude artifact
anymore) — same features, but now backed by a real database so it works
outside this chat.

## 1. Set up Supabase (the database)

1. Go to https://supabase.com, sign up, and create a new project (free tier is fine).
2. Once it's created, open the **SQL Editor** in the left sidebar, paste in the
   contents of `supabase_schema.sql` from this folder, and run it. This creates
   the one table the whole app uses.
3. Go to **Project Settings > API**. Copy the **Project URL** and the
   **anon public** key — you'll need both in step 3 below.

## 2. Set up Google Maps address autocomplete (optional but recommended)

1. Go to https://console.cloud.google.com and create a project (or use an existing one).
2. Enable two APIs: **Maps JavaScript API** and **Places API** (APIs & Services > Library).
3. Create an API key (APIs & Services > Credentials > Create Credentials > API key).
4. Restrict the key to **HTTP referrers** and add your future domain
   (e.g. `luxri.vercel.app/*`) once you know it — you can add it after your
   first deploy.
5. Google requires billing to be enabled on the project, but the free monthly
   credit comfortably covers normal usage for a business your size.

If you skip this step, the app still works fine — pickup/drop-off just stay
as plain text fields instead of autocompleting.

## 3. Deploy to Vercel

1. Push this folder to a GitHub repository (Vercel deploys from GitHub).
2. Go to https://vercel.com, sign up/log in, and click **Add New > Project**,
   then import that repository. Vercel auto-detects this as a Vite app —
   no configuration needed.
3. Before deploying, add your environment variables (Vercel will prompt you,
   or find it under Project Settings > Environment Variables afterward):
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
   - `VITE_GOOGLE_MAPS_KEY` (optional, from step 2)
4. Click **Deploy**. In a minute or two you'll get a live URL like
   `luxri.vercel.app`.
5. If you set up Google Maps, go back and add that exact URL to the API
   key's allowed referrers.

## After that

- Every time you want changes made, tell me here, I'll update the code, and
  you push the updated files to GitHub — Vercel redeploys automatically.
- The Driver Dashboard passcode is still the placeholder `1234` — swap it
  for something only you know before sharing the app widely (search for
  `dashPass !== "1234"` in `src/App.jsx`).
- Text/SMS buttons (notify chauffeur, confirm ride, referral invite) still
  use the "tap to send" pattern — they open the phone's Messages app
  pre-filled rather than sending silently, same as before.

