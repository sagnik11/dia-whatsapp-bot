# Admin and ops (Phase 2)

Patch keeps four registers in Cloudflare D1 for the founders: the compliance register, metrics, the sales pipeline and the hiring pipeline. It can also draft the monthly investor update from them. Every write is confirmed from the stored row, deletes are soft, and changes go to `audit_events`.

## What founders can ask

### Compliance register (`CO<id>`)

Patch only tracks what the founders or their CA give it. It never adds, suggests or assumes a filing, authority, form, due date or penalty, and it gives no legal or tax advice.

| Ask | Tool |
| --- | --- |
| "Here's the list from our CA: GSTR-3B monthly, next due 20 Nov; DIR-3 KYC yearly, 30 Sep…" | `add_compliance_items` (bulk, up to 40) |
| "What filings are due this month?", "anything overdue?" | `list_compliance` (within N days, overdue first) |
| "CO3 is filed" | `update_compliance` with `done`: a recurring item moves to its next due date, a one-off is archived, and the open task for that period is closed |
| "CO3's due date is actually 30 Nov", "Tanvi owns CO4 now" | `update_compliance` with `edit`; a date change moves the period's task too |
| "Delete CO5" | `update_compliance` with `delete` (soft delete) |

Each item has a name, authority, area (Legal or Finance, inferred from the name if not given), due date, recurrence (none, monthly, quarterly, yearly), owner, lead days (default 14), checklist and notes. Monthly, quarterly and yearly items keep their day of the month, so a 31st deadline goes 31 Jan, 28 Feb, 31 Mar.

**Silent tasks.** About once an hour a scheduled job adds a normal task for every active item whose due date is within its lead days (or already past): title = the item's name, owner = the item's owner, area Legal or Finance, tag `compliance`, due = the item's due date, with the checklist in the notes. The task's source id is `compliance:<id>:<due date>`, so each period gets exactly one task however often the job runs. The job never posts to WhatsApp.

### Metrics

| Ask | Tool |
| --- | --- |
| "MRR 1.2L, 3 pilots, 41 repos" | `log_metrics` (one entry per number) |
| "How has MRR moved since August?" | `metric_trend` (series plus absolute and percent change) |
| "Latest numbers?" | `latest_metrics` (each metric against the value before it) |

Values are read the way founders type them: `1.2L` / `1.2 lakh` = 1,20,000, `2.5Cr` / `2.5 crore` = 2,50,00,000, `40k` = 40,000, `1,20,000` = 120000, and `₹`/`Rs` mark money. Anything else is rejected rather than guessed. Names are stored lowercase. Logging a metric again for the same date is treated as a correction: trends use the latest entry for each date.

### Pipelines (`P<id>` deals, `C<id>` candidates)

| Ask | Tool |
| --- | --- |
| "Add Acme to pilots, ₹4.8L, next step DPA by Friday" | `create_deals` |
| "Pipeline?", "what's stuck?" | `list_pipeline` |
| "P2 is in negotiation", "clear P3's next step", "delete P4" | `update_deals` |
| "New candidate Priya for founding engineer" | `create_candidates` |
| "Who's in interviews?" | `list_candidates` |
| "Move C1 to offer, next action send offer letter by Monday" | `update_candidates` |

Deal stages: lead, qualified, pilot, negotiation, won, lost. Candidate stages: sourced, screen, interview, offer, hired, rejected. Lists show open stages by default, counts by stage, the open pipeline value, and flags: stuck (same stage for `PIPELINE_STALE_DAYS` or more), no next step, and next step overdue. Creating a company (or person and role) that is already open returns the existing row instead of a duplicate.

### Investor update draft

"Draft October's investor update" calls `draft_investor_update` for a `YYYY-MM` month (default: last month). Patch gathers what is stored:

- tasks marked done that month,
- metrics logged that month, with the change against the previous value,
- decisions logged in this group's memory that month,
- deals won or lost that month, hires that month, and the currently open deals and candidates.

The model is told to use only that data, copy numbers exactly, and write the sections Highlights, Metrics, Product, Customers/pipeline, Hiring and Asks (Asks stays "[Founders to add]" unless the data has one). The reply is labelled **DRAFT** and is never sent anywhere. If nothing happened in the month, Patch says so instead of drafting.

## Ground rules

- Edits and deletes need an id the founder named in the message (`CO3`, `P2`, `C4`, "compliance 3", "deal 2", "candidate 4") or that a list call returned in the same request, as with Phase 1.
- Every confirmation is built from the stored row, not from model text.
- Nothing in this module posts to the group on its own.

## Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `ADMIN_OPS_ENABLED` | `true` | Set `false` to remove these tools and the compliance job. |
| `COMPLIANCE_LEAD_DAYS` | `14` | Lead days for compliance items added without one. |
| `PIPELINE_STALE_DAYS` | `14` | Days in one stage before an open deal or candidate is flagged stuck. |

The tables (`compliance_items`, `metrics`, `pipeline`, `candidates`) are created on startup; `migrations/0004_admin.sql` creates them ahead of time with `wrangler d1 execute`.

## Limitations

- The compliance register starts empty. Patch does not know Indian statutory deadlines and will not fill them in; load the CA's list.
- Irregular schedules (for example quarterly TDS returns due 31 Jul, 31 Oct, 31 Jan and 31 May) do not fit a fixed recurrence. Add them as one-offs, or edit the due date after each filing.
- Marking a compliance item done closes the period's task, but closing the task does not mark the item done. Tell Patch "CO3 done".
- Metrics cannot be deleted from chat; log a correction for the same date instead.
- The investor update's open pipeline is as of today, not as of the month's end. Spends and the raw group conversation are not used yet. The draft uses the chat model's reasoning setting.
- Tasks closed in the month are read from the 200 most recently closed tasks since the month began.
