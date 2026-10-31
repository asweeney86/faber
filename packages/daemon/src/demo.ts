import {
  createCollection,
  linkDocToMeeting,
  recordVisit,
  runQueue,
  setCollectionDoc,
  setContent,
  setNote,
  setPinned,
} from "@faber/core";
import type { AppContext } from "./context";

const DAY = 86_400_000;

interface DemoDoc {
  url: string;
  title: string;
  /** Days ago for each visit. */
  visits: number[];
  meeting?: string;
  pinned?: boolean;
  note?: string;
  text: string;
}

const gdoc = (id: string) => `https://docs.google.com/document/d/${id}/edit`;
const gslides = (id: string) => `https://docs.google.com/presentation/d/${id}/edit`;
const gsheet = (id: string) => `https://docs.google.com/spreadsheets/d/${id}/edit`;

export const DEMO_DOCS: DemoDoc[] = [
  {
    url: gdoc("1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcd"),
    title: "Usage-Based Pricing: Rate Limit Design",
    visits: [0.1, 1, 3, 9, 20],
    meeting: "Billing v2 sync",
    pinned: true,
    note: "The one we approved. Burst pricing still open.",
    text: `Usage-Based Pricing: Rate Limit Design
Author: Maya Chen (Infra Platform)   Reviewers: Priya Natarajan, Tom Okafor
Status: Approved   Last updated: April 14, 2026

Context
Project Atlas moves us from flat seats to usage-based billing in Q2 2026. Billing v2 needs enforceable per-tier limits so that customers on the Starter tier cannot exceed the throughput they pay for.

Proposal
We implement a token-bucket limiter at the API gateway keyed by org_id and tier. Buckets refill at the tier's sustained rate (Starter 50 rps, Growth 500 rps, Enterprise negotiated) with a burst capacity of 10x. Limits are stored in the Atlas config service and pushed to gateways via the existing watch stream.

Open questions
Burst pricing: should burst usage above the sustained rate be billed at a premium? Finance (Tom Okafor) prefers a 1.5x multiplier; Product prefers including it in the tier.

Decision
Approved in the April 10 Billing v2 sync. Shadow mode starts April 21. Burst pricing deferred to the Q3 pricing review.`,
  },
  {
    url: gdoc("1ZyXwVuTsRqPoNmLkJiHgFeDcBa9876543210zyxw"),
    title: "Q3 Planning Sync - Growth",
    visits: [0.5, 2, 6],
    meeting: "Growth weekly",
    text: `Q3 Planning Sync — Growth Team
Date: July 8, 2026   Attendees: Dana Ruiz, Priya Natarajan, Sam Whitfield, Lin Zhao

Agenda
Onboarding funnel results from the June experiment (Project Kickstart). EU data residency: blockers for the Frankfurt region launch (Project Frankfurt). Headcount and OKR drafts.

Notes
Onboarding: the shortened signup flow (experiment ONB-42) lifted activation 7.3%. Dana Ruiz to ship to 100% by July 20.
EU data residency: Lin Zhao reports that customer data for EU orgs must stay in eu-central-1 including backups and analytics exports. The analytics export pipeline currently copies to us-east-1. Decision: block the Frankfurt launch until the export pipeline is regionalised; Sam Whitfield owns the fix, target end of August.
OKRs: Priya Natarajan to draft Q3 OKRs around activation rate and EU launch readiness by July 15.

Action items
Dana: ONB-42 to 100% (Jul 20). Sam: regionalise analytics export (Aug 31). Priya: Q3 OKR draft (Jul 15).`,
  },
  {
    url: gdoc("1PoStMoRtEmGaTeWaY503OutageMarch2026xyzab"),
    title: "Postmortem: API Gateway 503s (March 3)",
    visits: [40, 45, 50, 55],
    text: `Postmortem: API Gateway 503s
Incident date: March 3, 2026   Severity: SEV-2   Author: Tom Okafor
Incident commander: Maya Chen

Summary
For 47 minutes, 18% of API requests returned 503 after a config push removed the health-check route from the gateway fleet (Project Bedrock).

Root cause
A config template change in Project Atlas dropped the /healthz route. Load balancers marked healthy nodes as down and drained them.

Action items
Add a canary stage for gateway config pushes (Maya Chen). Alert on healthy-host count dropping below 70% (Tom Okafor). Add a lint rule for required routes.`,
  },
  {
    url: gdoc("1OkRsQ3GrOwThTeAmDrAfTv2activationEUlaunch"),
    title: "Growth Q3 OKRs (draft v2)",
    visits: [1.5, 4, 10],
    meeting: "Growth weekly",
    text: `Growth Q3 2026 OKRs — draft v2
Owner: Priya Natarajan   Last updated: July 15, 2026

Objective 1: Make new teams successful in their first week (Project Kickstart).
KR1: Raise 7-day activation from 31% to 38%.
KR2: Ship ONB-42 shortened signup to 100% of traffic.

Objective 2: Launch the Frankfurt region (Project Frankfurt).
KR1: EU customer data, backups and analytics exports stay in eu-central-1.
KR2: Ten design partners live in Frankfurt by end of Q3.`,
  },
  {
    url: gslides("1QwErTyUiOpAsDfGhJkLzXcVbNm0123456789qwer"),
    title: "Q2 Pricing Review",
    visits: [25, 30, 33, 38],
    meeting: "Pricing council",
    text: `Q2 Pricing Review
Presented by Tom Okafor and Priya Natarajan, May 20, 2026

Slide 1: Where revenue comes from today. Seats are 82% of revenue; usage overages 18%.
Slide 2: Usage-based pricing pilot. Twenty design partners on Project Atlas metering.
Slide 3: Proposed tiers: Starter, Growth, Enterprise with sustained rate limits.
Slide 4: Risks: bill shock, burst pricing perception, sales comp changes.
Slide 5: Ask: approve Growth tier at $499/month with 500 rps sustained.`,
  },
  {
    url: gsheet("1ShEeTcApAcItYpLaNnInG2026gatewayfleetabc"),
    title: "Gateway capacity plan 2026",
    visits: [12, 13],
    text: `# Project Bedrock gateway fleet capacity
region,current_nodes,peak_rps,target_rps,nodes_needed,owner
us-east-1,48,182000,250000,66,Maya Chen
eu-central-1,12,31000,60000,24,Lin Zhao
ap-southeast-2,8,15000,22000,12,Sam Whitfield`,
  },
  {
    url: gdoc("1RuNbOoKoNcAlLgAtEwAyDeGrAdEdpagerduty9876"),
    title: "Runbook: Gateway degraded",
    visits: [60, 62, 64, 70],
    text: `Runbook: Gateway degraded
Owner: Infra Platform on-call (Project Bedrock)

When to use this playbook: healthy-host count alert, elevated 5xx from the gateway, or latency p99 above 800ms.

Steps
1. Check the gateway dashboard for the affected region.
2. If a config push happened in the last hour, roll it back with deployctl rollback gateway-config.
3. If one zone is unhealthy, drain it and page the cloud provider.
4. Post status in #incidents every 15 minutes.`,
  },
  {
    url: gdoc("1PrDeUdAtAeXpOrTsReGiOnAlIsEaNaLyTiCs0001"),
    title: "PRD: Regional analytics exports",
    visits: [3, 5, 8],
    meeting: "Growth weekly",
    text: `PRD: Regional analytics exports
Author: Sam Whitfield   Stakeholders: Lin Zhao, Dana Ruiz   Status: In review
Date: August 4, 2026

Problem
Analytics exports for EU organisations are copied to us-east-1, which violates our EU data residency commitment and blocks the Frankfurt launch (Project Frankfurt).

User stories
As an EU admin, I need my exports processed and stored in the EU. As a data analyst, I need the same export schema in every region.

Requirements
Exports run in the customer's home region. Backups stay in-region. A residency audit log is available to admins.`,
  },
  {
    url: gdoc("1StAtUsUpDaTeWeEkLyInFrAoCtObEr2026abcdefg"),
    title: "Infra weekly status — Oct 26",
    visits: [0.2, 1],
    text: `Infra weekly status update — October 26, 2026
Author: Maya Chen

Progress
Rate limiter shadow mode completed; false-positive rate 0.02%. Enforcement for Starter tier begins November 3.
Project Bedrock: gateway config canary stage shipped (postmortem action item from the March 3 outage).

Risks
Burst pricing decision still pending with Finance (Tom Okafor).`,
  },
  {
    url: gdoc("1PoLiCyDaTaReTeNtIoNcUsToMeRdAtA2026xyzabc"),
    title: "Customer data retention policy",
    visits: [90, 100],
    text: `Customer data retention policy
Owner: Legal & Security   Effective: January 1, 2026

Customer content is retained for the life of the contract plus 30 days. Backups are retained for 35 days. EU customer data, including backups, must remain in the EU region. Deletion requests are completed within 30 days.`,
  },
  {
    url: gdoc("1ReSeArChInTeRvIeWsOnBoArDiNgSmBjune2026ab"),
    title: "Research: onboarding interviews with small teams",
    visits: [35, 36, 42],
    text: `Research: onboarding interviews with small teams
Researcher: Dana Ruiz   Date: June 2, 2026

We interviewed 14 admins of teams under 20 people. The most common drop-off was the workspace setup step: 9 of 14 abandoned or delayed it. Participants wanted to invite teammates before configuring integrations. This study informed Project Kickstart experiment ONB-42 (shortened signup).`,
  },
  {
    url: gdoc("1RoAdMaPpLaTfOrMh2Twenty26infraatlasroadmap"),
    title: "Platform roadmap H2 2026",
    visits: [15, 18, 22],
    text: `Platform roadmap — H2 2026
Owner: Maya Chen

Q3: Project Atlas metering GA, rate limiter enforcement, gateway config canaries (Project Bedrock).
Q4: Project Frankfurt general availability, regional analytics exports, self-serve usage dashboards.
Dependencies: Finance decision on burst pricing; Legal sign-off on EU residency audit log.`,
  },
];

/** Load demo documents with realistic visit history, then enrich them with the configured providers. */
export async function seedDemo(ctx: AppContext, opts: { log?: (m: string) => void; at?: number } = {}) {
  const t = opts.at ?? Date.now();
  const { db } = ctx;
  for (const d of DEMO_DOCS) {
    let id = "";
    for (const daysAgo of [...d.visits].sort((a, b) => b - a)) {
      id = recordVisit(db, { url: d.url, title: d.title, ts: Math.round(t - daysAgo * DAY), origin: "manual" }).row.id;
    }
    setContent(db, id, d.text, { title: d.title });
    if (d.meeting) linkDocToMeeting(db, id, { title: d.meeting }, Math.round(t - Math.min(...d.visits) * DAY));
    if (d.pinned) setPinned(db, id, true);
    if (d.note) setNote(db, id, d.note);
  }
  await runQueue(
    { db, cfg: ctx.cfg, enricher: ctx.enricher, embedder: ctx.embedder, index: ctx.index, log: opts.log },
    {},
  );
  const atlas = createCollection(db, {
    name: "Project Atlas",
    description: "Usage-based billing: pricing, limits, metering.",
    query: { q: "atlas pricing rate limits billing" },
  });
  const frankfurt = createCollection(db, { name: "Frankfurt launch", description: "EU region and data residency." });
  const byTitle = (title: string) => db.query<{ id: string }, [string]>(`SELECT id FROM documents WHERE title = ?`).get(title)!.id;
  setCollectionDoc(db, frankfurt.id, byTitle("PRD: Regional analytics exports"), "pin");
  setCollectionDoc(db, frankfurt.id, byTitle("Q3 Planning Sync - Growth"), "pin");
  setCollectionDoc(db, frankfurt.id, byTitle("Customer data retention policy"), "pin");
  setCollectionDoc(db, atlas.id, byTitle("Gateway capacity plan 2026"), "pin");
  return { docs: DEMO_DOCS.length, collections: 2 };
}
