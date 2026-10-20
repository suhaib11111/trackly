# Email for sign-up and "Forgot password" (free, about 10 minutes)

Supabase's built-in email is only for testing: a few emails per hour, then "email rate limit exceeded".
A free email service fixes that. Brevo's free plan sends up to 300 emails a day.

## 1. Brevo (brevo.com)
1. Sign up for free. Use your own email.
2. **Senders, Domains & Dedicated IPs → Senders → Add a sender**: name `Trackly`, and your email.
   Brevo sends a confirmation email; click the link.
3. **SMTP & API → SMTP tab**. Write down:
   - SMTP server: `smtp-relay.brevo.com`
   - Port: `587`
   - Login: shown on that page (looks like `xxxx@smtp-brevo.com`)
   - Click **Generate a new SMTP key** and copy it. It's shown only once.

## 2. Supabase (project bag-tracker)
**Authentication → Emails → SMTP Settings → Enable custom SMTP**
- Sender email: the email you added in Brevo
- Sender name: `Trackly`
- Host: `smtp-relay.brevo.com` · Port: `587`
- Username: the Brevo SMTP login · Password: the SMTP key
- **Save**

Then **Authentication → Rate Limits** → "Rate limit for sending emails": raise it to e.g. `30` per hour.

## 3. Nice emails (optional)
**Authentication → Emails → Templates** → "Confirm signup" and "Reset password":
change the subject to "Trackly: confirm your email" / "Trackly: choose a new password".

## 4. Turn confirmation back on
**Authentication → Sign In / Providers → Email → Confirm email: on**. This is safer, because people
must own the email they sign up with.

Done. Sign-up and "Forgot password" emails now come from Trackly and won't hit the limit.
