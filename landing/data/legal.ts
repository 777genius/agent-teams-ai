export type LegalLink = {
  label: string;
  href: string;
};

export type LegalSection = {
  id: string;
  title: string;
  paragraphs: readonly string[];
  links?: readonly LegalLink[];
};

export type LegalDocument = {
  path: string;
  title: string;
  description: string;
  updatedAt: string;
  introduction: string;
  sections: readonly LegalSection[];
};

export const legalContactEmail = 'quantjumppro@gmail.com';

export const legalNavigation = [
  { label: 'Terms of Service', href: '/terms' },
  { label: 'Privacy Policy', href: '/privacy-policy' },
  { label: 'Refund Policy', href: '/refund-policy' },
] as const;

const buyerTerms: LegalLink = {
  label: 'Paddle Buyer Terms',
  href: 'https://www.paddle.com/legal/buyer-terms',
};

export const termsDocument: LegalDocument = {
  path: '/terms',
  title: 'Terms of Service',
  description: 'Terms for the Agent Teams AI website, desktop app, and any future paid services.',
  updatedAt: '2026-10-05',
  introduction:
    'Agent Teams AI is developed and operated under the QuantJumpPro brand. These terms describe use of agentteams.live and services offered by the developer.',
  sections: [
    {
      id: 'current-product',
      title: '1. Current product and open source rights',
      paragraphs: [
        'Agent Teams AI is currently a free, open source desktop application for organizing AI agent teams, tasks, sessions, and code review. No paid Agent Teams AI plans are available to purchase yet.',
        'The desktop source code is distributed under the GNU Affero General Public License, version 3, as set out in the repository LICENSE. That license governs your rights to use, inspect, modify, and redistribute covered software. These website and service terms do not restrict or replace rights granted by that license or the licenses of third-party components.',
      ],
      links: [
        {
          label: 'Repository LICENSE',
          href: 'https://github.com/777genius/agent-teams-ai/blob/main/LICENSE',
        },
      ],
    },
    {
      id: 'ai-tools',
      title: '2. AI runtimes, tools, and your responsibilities',
      paragraphs: [
        'The app works with the AI runtimes and providers you select, including free models where available. Their accounts, subscriptions, usage charges, service availability, and data handling are governed by their own terms. Installing the free desktop app does not include a paid subscription or paid API allowance with a third-party provider.',
        'Depending on your permissions and runtime configuration, AI agents can read and edit files, run commands, call tools, and communicate task context. Choose permissions carefully, keep appropriate backups, and review changes and outputs before relying on them or deploying them.',
        'You must have the rights and permissions needed for the projects, prompts, files, and other material you provide. Use the website and any services lawfully, respect the rights of others, and do not attempt unauthorized access or interfere with their security or operation.',
        'AI output may be inaccurate, incomplete, or unsuitable for your purpose. You remain responsible for evaluating it, including its security, accuracy, and compatibility with your obligations. No particular result or uninterrupted third-party provider access is guaranteed.',
      ],
    },
    {
      id: 'future-payments',
      title: '3. Future paid services',
      paragraphs: [
        'The planned paid service provides AI usage through our backend using model provider APIs paid for by us. Monthly plans may include an allowance for this service, and one-time packs may provide additional usage. These purchases do not pay for or extend subscriptions you hold separately with third-party providers.',
        'If paid services are launched, purchases will be processed by Paddle as merchant of record under its Buyer Terms. The offer and checkout will identify what is being purchased, the price, applicable taxes, billing interval, and any included usage allowance before payment.',
        'A subscription renews at the interval shown at checkout until canceled. You can manage cancellation through the link provided with your purchase or Paddle buyer support. Cancellation prevents future renewal; scheduled access continues through the paid period unless a refund or another applicable termination ends it earlier.',
        'The proposed structure separates the monthly included allowance from credits bought in one-time packs. Monthly allowances are intended to reset each billing period without rollover. Optional purchased credits are intended to be used after the monthly allowance is exhausted; they are a separate balance and are not the monthly allowance.',
        'This structure is provisional. Final prices, allowance amounts, supported models, model usage rates, and any conditions for purchased credits, including validity and subscription dependence, will be disclosed before purchase. This page does not set a credit expiry date or offer paid usage now. Future paid offerings do not remove the rights attached to the open source desktop software.',
      ],
      links: [buyerTerms, { label: 'Paddle buyer support', href: 'https://www.paddle.net/' }],
    },
    {
      id: 'service-conditions',
      title: '4. Service changes and consumer rights',
      paragraphs: [
        'Features may evolve as the product develops. We may make prospective changes to these terms, prices, allowances, supported models, or model usage rates. Material changes affecting an existing paid service will be notified in advance, including when they take effect and any applicable cancellation or other options; consent will be obtained where required by law. Changes do not retroactively reduce paid entitlements or remove accrued rights. We may restrict a hosted service to address misuse, security incidents, or legal requirements, subject to applicable rights and without changing your open source license rights.',
        'The open source software has the warranty and liability provisions stated in its license. Nothing in these terms excludes rights or remedies that applicable law does not allow to be excluded, including mandatory consumer protections.',
      ],
    },
    {
      id: 'updates-contact',
      title: '5. Updates and contact',
      paragraphs: [
        'Updates to these terms will be published here with a revised date. Material changes to paid services will be notified where required and do not retroactively remove accrued rights. For product questions or a concern about these terms, contact QuantJumpPro at the email below.',
      ],
    },
  ],
};

export const privacyDocument: LegalDocument = {
  path: '/privacy-policy',
  title: 'Privacy Policy',
  description:
    'How Agent Teams AI handles local app data, provider context, website visits, and support information.',
  updatedAt: '2026-10-05',
  introduction:
    'QuantJumpPro is the operator brand for Agent Teams AI and the contact for the personal data described here that we control. This policy covers agentteams.live and the desktop app; the AI providers and other services you choose also have their own policies.',
  sections: [
    {
      id: 'local-app-data',
      title: '1. Local desktop data',
      paragraphs: [
        'The desktop app runs on your computer and reads local project and runtime data to provide its interface. Project files, team configuration, tasks and comments, inbox messages, session logs, launch diagnostics, review state, and app settings are generally stored locally.',
        'The app is not a cloud repository sync service and does not need to upload your whole project to an Agent Teams server to display its board, logs, or review interface. Local data remains under your control, subject to the provider context and telemetry described below. You can manage or remove local files and settings on your computer; deleting them may remove history or affect running workflows.',
      ],
    },
    {
      id: 'provider-context',
      title: '2. Context sent to your selected providers',
      paragraphs: [
        'When you ask an agent to work, the selected runtime may send prompts, relevant file contents, attachments, task text, comments, tool results, command output, and other context to a model provider. The data sent depends on your runtime, permissions, model, task, and tool use.',
        'The providers you select govern their authentication, retention, training, regional processing, and billing under their own policies. Review those policies before using confidential material, and avoid placing secrets in prompts or attachments. Local-first operation does not mean that remote model calls receive no project data.',
      ],
    },
    {
      id: 'telemetry',
      title: '3. Diagnostics and product analytics',
      paragraphs: [
        'In distributed builds configured with Sentry, crash and performance telemetry is enabled by default. When active, it may transmit error and diagnostic information, sampled performance traces, app release and environment information, and a pseudonymous installation identifier to help diagnose reliability issues. You can disable it in Settings > General, in the privacy controls.',
        'The app applies redaction of sensitive fields and disables integrations that could collect unnecessary context. These protections reduce exposure but are not a promise that every possible sensitive value will be removed. Self-built versions without a configured Sentry connection do not send Sentry telemetry.',
        'Official builds may also include PostHog product analytics when explicitly configured. With telemetry enabled, this records product interactions, such as onboarding and feature use, coarse usage or outcome information, app and build information, and a pseudonymous installation identifier. The same Settings > General privacy control disables this analytics collection. PostHog is inactive when its official-build configuration is absent.',
      ],
      links: [
        { label: 'Sentry Privacy Policy', href: 'https://sentry.io/privacy/' },
        { label: 'PostHog Privacy Policy', href: 'https://posthog.com/privacy' },
      ],
    },
    {
      id: 'website',
      title: '4. Website preferences and external services',
      paragraphs: [
        'The website uses a language preference cookie and stores your theme preference in a cookie and local storage. You can clear or restrict these through your browser settings; the website may then forget your preferences.',
        'The website loads Google Fonts and Mux demo media, and links to GitHub for downloads and source code. Loading fonts or media can send your IP address, browser information, and request details to those services. Visiting GitHub places you under its policies. Website hosting providers may process access logs containing IP addresses, browser information, and requested URLs to deliver and secure the website.',
      ],
      links: [
        { label: 'Google Privacy Policy', href: 'https://policies.google.com/privacy' },
        { label: 'Mux Privacy Policy', href: 'https://www.mux.com/privacy' },
        {
          label: 'GitHub Privacy Statement',
          href: 'https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement',
        },
      ],
    },
    {
      id: 'support-billing',
      title: '5. Support and future billing',
      paragraphs: [
        'If you contact us, we receive the email address, message, and any logs or attachments you voluntarily provide. We use them to answer your request and investigate the issue. Share only what is necessary and remove secrets or unrelated personal information first.',
        'No paid Agent Teams AI plans can currently be purchased. If paid services launch, Paddle will process payments as merchant of record. We may receive customer contact details, order and subscription identifiers, purchased products, billing status, and transaction information needed to provide access and support. Payment credentials are handled by Paddle and its payment partners under their policies.',
        'When the planned hosted AI service becomes available, its requests and the context you choose to provide will pass through our backend and the model provider APIs used to fulfill the request. We will also process account identifiers and usage information needed to manage access, credit balances, and billing. The applicable provider and service data-handling conditions will be disclosed before paid use becomes available.',
      ],
      links: [{ label: 'Paddle Privacy Policy', href: 'https://www.paddle.com/legal/privacy' }],
    },
    {
      id: 'purposes-sharing',
      title: '6. Purposes, legal bases, and sharing',
      paragraphs: [
        'Where data protection law requires a legal basis, we rely on performance of a contract or steps you request before a contract for support and service delivery; legitimate interests for proportionate security and reliability work; consent where required for optional processing; and legal obligations where applicable.',
        'Service providers may process data to deliver hosting, email, diagnostics, product analytics, media, and future payments. Data may also be disclosed when required by law or necessary to address a legal or security issue. These providers and your selected AI providers may process information in other countries under their policies and applicable safeguards. We do not sell your personal data.',
      ],
    },
    {
      id: 'retention-rights',
      title: '7. Retention and your choices',
      paragraphs: [
        'We keep data we control for as long as needed for its stated purpose, relevant support follow-up, security, or legal obligations. Provider retention is governed by the respective provider. Local app history remains on your computer until managed by you or the relevant runtime.',
        'Depending on applicable law, you may request access, correction, deletion, restriction, or portability of personal data we control, object to relevant processing, or withdraw consent where processing relies on it. Contact the email below. We may need to verify the request and retain information required by law. You may also raise a concern with your local data protection authority.',
        'Requests to us cannot erase files only stored on your computer or data held independently by your chosen provider. Manage local data directly and contact the relevant provider for its data. Updates to this policy will be published here with a revised date, with additional notice where required.',
      ],
    },
  ],
};

export const refundDocument: LegalDocument = {
  path: '/refund-policy',
  title: 'Refund Policy',
  description: 'Refund and cancellation information for any future Agent Teams AI paid services.',
  updatedAt: '2026-10-05',
  introduction:
    'Agent Teams AI is currently free and open source, and no paid plans are available to purchase. This policy describes how refund requests will be handled for future paid Agent Teams AI services when they become available.',
  sections: [
    {
      id: 'scope',
      title: '1. Scope and statutory rights',
      paragraphs: [
        'This policy applies to paid Agent Teams AI services offered under the QuantJumpPro brand through Paddle when launched. It does not govern payments made directly to an AI runtime or provider; contact that provider for its billing and refunds.',
        'Mandatory consumer rights, including applicable withdrawal rights and remedies for faulty or undelivered services, remain unaffected. Eligibility is assessed under applicable law, Paddle Buyer Terms, and the conditions disclosed for the purchase. This is not an unconditional refund promise for every renewal.',
      ],
      links: [buyerTerms],
    },
    {
      id: 'request',
      title: '2. Requesting a refund',
      paragraphs: [
        'For a future Paddle purchase, request a refund through Paddle buyer support at paddle.net or contact us using the email below. Include your purchase email, order or transaction reference, and a brief explanation. Do not send full payment card details.',
        'Paddle processes eligible refunds to the original payment method where possible. The processing time depends on the payment method and financial institution; we do not promise a fixed arrival date. Requests concerning billing errors or a service that was not delivered should identify the affected transaction so it can be investigated.',
      ],
      links: [
        { label: 'Paddle buyer support', href: 'https://www.paddle.net/' },
        { label: 'Paddle Refund Policy', href: 'https://www.paddle.com/legal/refund-policy' },
      ],
    },
    {
      id: 'cancellation',
      title: '3. Cancellation and refunds are different',
      paragraphs: [
        'Canceling a subscription prevents future renewals and normally leaves scheduled access available through the paid period. It does not automatically refund an earlier charge. You can cancel through the purchase confirmation link or Paddle buyer support; request a refund separately where applicable.',
        'If a refund is issued, the access or unused allowance associated with the refunded purchase may be revoked as applicable. Any future additional usage credit offer will state its conditions before purchase; no blanket nonrefundable credit rule is established here.',
      ],
    },
    {
      id: 'contact',
      title: '4. Questions and updates',
      paragraphs: [
        'For product or refund questions, contact QuantJumpPro at the email below. This policy will be updated before paid offerings are made available, with material changes communicated as required by applicable law. Open source license rights are unaffected by cancellation or a refund for a separate paid service.',
      ],
    },
  ],
};
