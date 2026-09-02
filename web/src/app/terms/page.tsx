import Link from "next/link";
import { Target } from "lucide-react";

export const metadata = {
  title: "Terms of Service — Applicient",
  description: "The terms governing your use of Applicient.",
};

const LAST_UPDATED = "September 2, 2026";

export default function TermsOfServicePage() {
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
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Terms of Service</h1>
        <p className="mt-2 text-sm text-muted-foreground">Last updated: {LAST_UPDATED}</p>

        <div className="mt-10 flex flex-col gap-8 text-sm leading-relaxed text-foreground/90">
          <section>
            <p>
              These terms govern your use of Applicient (the &quot;Service&quot;). By creating an
              account, you agree to them. If you don&apos;t agree, don&apos;t use the Service.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold tracking-tight">1. The Service</h2>
            <p className="mt-3">
              Applicient helps you discover, evaluate, and apply to jobs: it builds a profile from your
              CV, scores job postings against it, generates tailored application documents, and can
              optionally track application status via Gmail and automate filling in application forms.
              The Service is provided on a subscription basis with usage limits tied to your plan.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold tracking-tight">2. Your account</h2>
            <ul className="mt-3 flex flex-col gap-2 list-disc pl-5">
              <li>You&apos;re responsible for keeping your login credentials secure and for all activity under your account.</li>
              <li>You must provide accurate information — the CV and profile data you supply is used to represent you to prospective employers, so its accuracy is your responsibility, not ours.</li>
              <li>You must be legally permitted to work in the jurisdictions you apply to and to use the accounts (e.g. Gmail) you connect.</li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold tracking-tight">3. AI-generated content and no guarantee of outcomes</h2>
            <p className="mt-3">
              Job fit scores, tailored CVs, cover letters, and other generated content are produced with
              the assistance of third-party AI models and may contain errors. You are responsible for
              reviewing any generated document before it is submitted anywhere on your behalf. Applicient
              does not guarantee that using the Service will result in interviews, offers, or employment
              of any kind.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold tracking-tight">4. Automated application submission</h2>
            <p className="mt-3">
              The Service can automate filling in job application forms on third-party sites and applicant
              tracking systems on your behalf. By default, the automation stops before final submission so
              you can review every field and attachment. If you enable a higher autonomy setting that
              submits without your review, you do so at your own discretion and accept responsibility for
              what is submitted. You&apos;re responsible for complying with the terms of service of any
              third-party site or platform the Service interacts with on your behalf.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold tracking-tight">5. Subscriptions and billing</h2>
            <ul className="mt-3 flex flex-col gap-2 list-disc pl-5">
              <li>Paid plans are billed on a recurring basis through our payment processor.</li>
              <li>Usage beyond your plan&apos;s cap may be paused until your next billing period or until you upgrade.</li>
              <li>You can cancel at any time; access continues until the end of the current billing period.</li>
              <li>Fees are non-refundable except where required by law.</li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold tracking-tight">6. Acceptable use</h2>
            <p className="mt-3">You agree not to:</p>
            <ul className="mt-3 flex flex-col gap-2 list-disc pl-5">
              <li>Use the Service to misrepresent your identity, qualifications, or work history to an employer.</li>
              <li>Use the Service to submit spam or bulk applications with no genuine interest in the role.</li>
              <li>Attempt to circumvent usage limits, reverse-engineer the Service, or interfere with its normal operation.</li>
              <li>Use the Service for any unlawful purpose.</li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold tracking-tight">7. Data and privacy</h2>
            <p className="mt-3">
              Our{" "}
              <Link href="/privacy" className="underline hover:text-foreground">
                Privacy Policy
              </Link>{" "}
              describes what data we collect and how it&apos;s used, including your Gmail data if you
              choose to connect it. It&apos;s part of these terms.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold tracking-tight">8. Termination</h2>
            <p className="mt-3">
              You may stop using the Service and request account deletion at any time. We may suspend or
              terminate an account that violates these terms, including the acceptable-use rules above.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold tracking-tight">9. Disclaimer and limitation of liability</h2>
            <p className="mt-3">
              The Service is provided &quot;as is&quot;, without warranties of any kind. To the maximum
              extent permitted by law, Applicient is not liable for indirect, incidental, or consequential
              damages arising from your use of the Service, including any outcome (or lack of outcome)
              of a job application made using it.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold tracking-tight">10. Changes to these terms</h2>
            <p className="mt-3">
              We may update these terms as the product changes. Continued use of the Service after a
              change means you accept the updated terms.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold tracking-tight">11. Governing law</h2>
            <p className="mt-3">These terms are governed by the laws of the Republic of Indonesia.</p>
          </section>

          <section>
            <h2 className="text-lg font-semibold tracking-tight">12. Contact</h2>
            <p className="mt-3">
              Questions about these terms can be sent to{" "}
              <a href="mailto:ramadhanadrian2710@gmail.com" className="underline hover:text-foreground">
                ramadhanadrian2710@gmail.com
              </a>
              .
            </p>
          </section>
        </div>
      </main>
    </div>
  );
}
