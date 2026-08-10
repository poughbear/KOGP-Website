# KOGP gallery administration setup

The private review page is available at `/admin/gallery/`. Complete these one-time setup steps after the code is deployed.

## 1. Authorize reviewer emails in Netlify

In **Netlify > Site configuration > Environment variables**, add:

```text
GALLERY_ADMIN_EMAILS=reviewer@example.com
```

For multiple reviewers, separate addresses with commas:

```text
GALLERY_ADMIN_EMAILS=first@example.com,second@example.com
```

Apply the variable to all deploy contexts that need the dashboard, then trigger a new deploy. Do not place this value or any Supabase secret in browser-side JavaScript.

## 2. Allow the authentication redirects in Supabase

In **Supabase > Authentication > URL Configuration**, use:

- Site URL: `https://kogp.org`
- Redirect URL: `https://kogp.org/admin/gallery/`
- Netlify deploy previews, if needed: `https://**--kogporg.netlify.app/**`

The production URL should be listed exactly. The wildcard is only for Netlify preview deployments.

## 3. Create or invite each reviewer

In **Supabase > Authentication > Users**, invite or create a user for every email in `GALLERY_ADMIN_EMAILS`. The email spelling must match, although capitalization does not matter.

The dashboard requests passwordless magic links only for existing users. It does not permit public sign-up.

## 4. Sign in and review

1. Open `https://kogp.org/admin/gallery/`.
2. Enter an authorized reviewer email.
3. Open the secure sign-in link from that email in the same browser.
4. Review one photo at a time, select several photos for a bulk action, or revisit the Approved and Rejected tabs.

Approvals and rejections are reversible. Use **Undo** immediately after an action, or open the Approved/Rejected tab later and return a photo to Pending or give it a different decision.

## Security notes

- `SUPABASE_SECRET_KEY` remains inside the Netlify function and is never returned to the browser.
- Every review request is authenticated with Supabase and checked against `GALLERY_ADMIN_EMAILS` before the secret-key client is created.
- Pending and rejected images remain in the existing private Storage bucket.
- The existing Storage and database RLS policies do not need to be changed.
- Photo preview links expire after ten minutes, and dashboard/API responses are marked `no-store`.
