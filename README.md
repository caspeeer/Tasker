# Team Tasks CMS

A static HTML/CSS/JavaScript team task workspace backed by Supabase. Task assignment, review, notification creation, and star awards are enforced by PostgreSQL functions and RLS. Resend credentials are used only by the Supabase Edge Function.

## Project files

- `index.html` and `assets/`: static Vercel frontend
- `supabase/migrations/001_initial_schema.sql`: schema, RLS, RPCs, and Realtime publication
- `supabase/functions/send-notification/index.ts`: authenticated server-side email delivery
- `vercel.json`: static hosting headers and clean URLs

## 1. Create Supabase project

Create a project in the Supabase dashboard and keep its database password private. Copy the project URL and the `anon`/publishable key from **Project Settings → API**. The browser uses only this public key; never put the `service_role` key in frontend files.

## 2. Run the database migration

From the Supabase dashboard, open **SQL Editor**, paste the complete contents of `supabase/migrations/001_initial_schema.sql`, and run it once. It creates the normalized tables, indexes, RLS policies, auth profile trigger, secure RPCs, and Realtime publication entries.

Review the SQL migration before applying it to an existing project. It is intended for a new project and does not attempt to merge with pre-existing tables of the same names.

## 3. Configure Supabase Authentication

In **Authentication → Providers**, enable Email. Configure email confirmation to match your team's account policy. Under **Authentication → URL Configuration**, set the Site URL to your production origin and add your Vercel preview and production URLs to the redirect allow list.

The sign-up form can create only regular users. The database trigger always assigns the `user` role; the browser has no role selector or role-update permission.

## 4. Configure the public frontend settings

Set `supabaseUrl` and `supabaseAnonKey` in `assets/js/config.js` using the project URL and public anon/publishable key from step 1. These values are necessarily visible to browser users and are not secrets; RLS is the security boundary. Do not put database passwords, service-role keys, or Resend credentials in this file.

## 5. Configure Resend and deploy the Edge Function

Create a Resend account, verify a sending domain, and create an API key. Install and authenticate the Supabase CLI, then link this folder to the project:

```powershell
npx supabase login
npx supabase link --project-ref YOUR_PROJECT_REF
npx supabase secrets set RESEND_API_KEY=YOUR_RESEND_KEY RESEND_FROM="Team Tasks <azngload.tracking081@gmail.com>" APP_ORIGIN=https://your-domain.example
npx supabase functions deploy send-notification
```

The function also reads `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` from its Supabase runtime. Those values remain server-side. `APP_ORIGIN` must be the exact website origin without a trailing slash; it controls CORS and links in email. Use the verified Resend sender address for `RESEND_FROM`.

Email delivery is logged per recipient, task, and event type. A sent message is not resent on retry; failed deliveries can be retried from **Manage Tasks**. Website notifications are created transactionally with task assignment and review, independently of email delivery.

## 6. Create the first Admin account

Create the intended admin account through the app's sign-up form and complete email confirmation if enabled. In Supabase SQL Editor, promote that exact account using its verified email:

```sql
update public.profiles
set role = 'admin'
where email = 'admin@your-domain.example';
```

Verify exactly one row changed. Admin role changes are deliberately an out-of-band database operation; the app has no public admin registration flow. Keep at least one active admin account.

## 7. Connect GitHub to Vercel

Push this folder to a private GitHub repository. In Vercel, choose **Add New → Project**, import the repository, and set the project root to this folder if it is inside a monorepo. No build command or output directory is required; Vercel serves the static files directly.

## 8. Deploy the website

Deploy from the Vercel import flow or connect the repository for automatic deployments. After the first deployment, open the Vercel URL and confirm the sign-in screen loads. If the setup screen appears, check `assets/js/config.js` and redeploy. Verify auth, database access, Realtime, and Edge Function invocation using test accounts before inviting the team.

## 9. Configure a production domain

In **Vercel → Project → Settings → Domains**, add the production hostname and apply the DNS records Vercel provides. Wait for TLS provisioning, then update all of the following to the final HTTPS origin:

- Supabase Auth Site URL and redirect allow list
- Supabase `APP_ORIGIN` secret, followed by redeploying `send-notification`
- Email links will then point to the production task view

## Security and behavior notes

- RLS protects every application table. Users can read their own assignments and notifications; admins receive broader access only after a database role check.
- Task creation, status changes, reviews, notification writes, and user activation changes use validated database functions. Direct user writes to task, assignment, and star tables are not granted.
- Approval and the unique `(task_id, user_id)` star constraint prevent duplicate rewards. Star history is retained; month/week/day scores are calculated from UTC transaction timestamps.
- Leaderboard windows are UTC calendar day, Monday-based UTC week, and UTC month. Equal scores sort by approved task count, name, then user ID.
- Deleting a task that has awarded stars is blocked by its history foreign key. Deactivate users rather than deleting accounts with retained history.
- The workspace does not use mock application records. Supabase setup is required before sign-in or team data is available.