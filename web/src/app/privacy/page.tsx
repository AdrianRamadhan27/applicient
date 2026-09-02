import Link from "next/link";
import { Target } from "lucide-react";

export const metadata = {
  title: "Privacy Policy — Applicient",
  description: "How Applicient collects, uses, and protects your data.",
};

const LAST_UPDATED = "September 2, 2026";

export default function PrivacyPolicyPage() {
  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border">
        <div className="mx-auto flex h-14 max-w-3xl items-center gap-2 px-5">
          <Link href="/" className="flex items-center gap-2">
            <Target className="size-4 text-primary" strokeWidth={1.5} />
            <span className="font-mono text-sm font-semibold tracking-tight">applicient</span>
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-5 py-14">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Privacy Policy</h1>
        <p className="mt-2 text-sm text-muted-foreground">Last updated: {LAST_UPDATED}</p>

        <div className="mt-10 flex flex-col gap-8 text-sm leading-relaxed text-foreground/90">
          <section>
            <p>
              Applicient (&quot;we&quot;, &quot;us&quot;) is a job-application assistant: it helps you build a
              profile from your CV, discovers and scores job postings against that profile, generates
              tailored application documents, and can optionally track your application status through
              your Gmail inbox and automate filling in application forms. This policy explains what data
              we collect to do that, why, and how it&apos;s handled.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold tracking-tight">1. Information we collect</h2>
            <ul className="mt-3 flex flex-col gap-2 list-disc pl-5">
              <li>
                <strong>Account information</strong> — your email address, and either a hashed password
                or, if you sign in with Google, the identity Google provides (email, name, and a stable
                account identifier). We never see or store your Google password.
              </li>
              <li>
                <strong>Profile and CV data</strong> — the CV(s) you upload, and the work history,
                skills, and accomplishments extracted from them (or entered manually) into your profile
                and evidence bank. This is what job scoring and document generation are built on.
              </li>
              <li>
                <strong>Job data</strong> — postings discovered through your searches or added manually,
                and the fit scores, tailored CVs, and cover letters generated for them.
              </li>
              <li>
                <strong>Application tracking data</strong> — which jobs you&apos;ve applied to, their
                status, and any notes or documents attached to that application.
              </li>
              <li>
                <strong>Gmail data (optional)</strong> — if you connect Gmail, we request read-only
                access to your inbox solely to detect messages related to your job applications
                (e.g. interview invitations, rejections, offers) and match them to the corresponding
                application so its status stays up to date. See section 3 for detail on how this is
                handled; you can disconnect Gmail access at any time.
              </li>
              <li>
                <strong>Billing information</strong> — your subscription plan and payment status.
                Card and payment-method details are handled entirely by our payment processor; we do
                not receive or store full card numbers.
              </li>
              <li>
                <strong>Usage data</strong> — basic operational logs (e.g. which features you use, error
                logs) used to keep the service running and to enforce plan usage limits.
              </li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold tracking-tight">2. How we use your information</h2>
            <ul className="mt-3 flex flex-col gap-2 list-disc pl-5">
              <li>To operate the core product: matching, scoring, and tailoring documents against jobs.</li>
              <li>
                To generate content, your profile and the relevant job description are sent to a
                third-party AI provider (e.g. OpenAI, Anthropic, or another provider we&apos;ve configured)
                to produce scores, tailored CVs, and cover letters. These providers process the data to
                return a result to us and do not use it to train their own models under our agreements
                with them, where such an agreement is available.
              </li>
              <li>To track your application status, including via matched Gmail messages, if connected.</li>
              <li>
                To automate form-filling on job application pages, when you explicitly trigger this — by
                default, the system stops before final submission for your review.
              </li>
              <li>To process billing and enforce your plan&apos;s usage limits.</li>
              <li>To communicate with you — account verification, billing notices, and, if enabled, summaries of scheduled search results.</li>
            </ul>
            <p className="mt-3">We do not sell your personal data, and we do not use it for advertising.</p>
          </section>

          <section>
            <h2 className="text-lg font-semibold tracking-tight">3. Gmail data specifically</h2>
            <p className="mt-3">
              If you connect your Gmail account, Applicient requests read-only access to your inbox
              (Google API scope <code className="rounded bg-muted px-1 py-0.5 text-xs">gmail.readonly</code>).
              This access is used exclusively to identify messages related to job applications you are
              tracking in Applicient and to update their status accordingly — it is never used to read,
              store, or process unrelated personal email, and never shared with third parties or used
              for advertising. The refresh token that grants this access is encrypted at rest. You can
              revoke this access at any time from within the app, or directly from your Google Account
              permissions, which immediately stops all further access. Applicient&apos;s use of information
              received from Google APIs adheres to the{" "}
              <a
                href="https://developers.google.com/terms/api-services-user-data-policy"
                target="_blank"
                rel="noreferrer"
                className="underline hover:text-foreground"
              >
                Google API Services User Data Policy
              </a>
              , including the Limited Use requirements.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold tracking-tight">4. How your data is protected</h2>
            <ul className="mt-3 flex flex-col gap-2 list-disc pl-5">
              <li>Sensitive credentials (Gmail refresh tokens, third-party provider API keys) are encrypted at rest.</li>
              <li>Passwords are hashed and never stored or logged in plain text.</li>
              <li>Access to your data is scoped to your account; other users cannot see your profile, jobs, or applications.</li>
              <li>Data is hosted on infrastructure we operate directly, not resold or shared with unrelated third parties.</li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold tracking-tight">5. Data retention and deletion</h2>
            <p className="mt-3">
              We retain your data for as long as your account is active. You may request deletion of
              your account and associated data at any time by contacting us (section 8) — we will
              delete your personal data except where we&apos;re required to retain certain records (e.g.
              billing history) for legal or accounting purposes.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold tracking-tight">6. Cookies and tracking</h2>
            <p className="mt-3">
              Applicient uses a browser-stored access token to keep you signed in — not third-party
              advertising or tracking cookies. We do not currently use third-party analytics or
              advertising trackers.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold tracking-tight">7. Children&apos;s privacy</h2>
            <p className="mt-3">
              Applicient is not directed at, and we do not knowingly collect data from, anyone under 16
              years old.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold tracking-tight">8. Contact</h2>
            <p className="mt-3">
              Questions about this policy, or requests to access or delete your data, can be sent to{" "}
              <a href="mailto:ramadhanadrian2710@gmail.com" className="underline hover:text-foreground">
                ramadhanadrian2710@gmail.com
              </a>
              .
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold tracking-tight">9. Changes to this policy</h2>
            <p className="mt-3">
              We may update this policy as the product changes. Material changes will be reflected by
              updating the &quot;Last updated&quot; date above.
            </p>
          </section>
        </div>
      </main>
    </div>
  );
}
