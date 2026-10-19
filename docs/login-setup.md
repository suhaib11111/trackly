# Login setup in Supabase (once)

## 1. "Forgot password" emails must open the app (needed now)
Supabase → project **bag-tracker** → **Authentication** → **URL Configuration**
- **Site URL:** `https://suhaib11111.github.io/trackly/`
- **Redirect URLs** → Add: `https://suhaib11111.github.io/trackly/**`

Without this, the reset email links to `localhost` and doesn't work.

Tip: Authentication → Sign In / Providers → Email → **Confirm email**. On = safer (people must confirm
their email). Off = faster for testing.

## 2. "Continue with Google" (optional, free)
1. Google Cloud Console (console.cloud.google.com) → create a project "Trackly".
2. APIs & Services → **OAuth consent screen** → External → app name Trackly, your email → Save.
3. APIs & Services → **Credentials** → Create credentials → **OAuth client ID** → Web application.
   - Authorized redirect URI: `https://lcrvuijwpvhphbuwxtny.supabase.co/auth/v1/callback`
4. Copy the **Client ID** and **Client secret**.
5. Supabase → Authentication → Sign In / Providers → **Google** → turn on, paste both → Save.
6. In `js/config.js` set `googleLogin: true` (or ask Claude to) and push.

The button only shows when `googleLogin` is `true`.
