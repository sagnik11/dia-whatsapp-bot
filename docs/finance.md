# Finance (Phase 2: money)

Patch handles bill photos, monthly roll-ups, founder reimbursements, a subscription radar and monthly budgets. Spends stay in the Notion Daily Spend Log. Subscriptions and budgets live in D1 (`migrations/0003_finance.sql`). Patch never posts about money unprompted: everything below runs only when a founder asks.

## What founders can ask

| Ask | What happens | Needs the spend log |
| --- | --- | --- |
| Send a bill photo or PDF with "log this bill" | The model reads vendor, date, final INR amount and category from the image and logs it with `add_spends` | Yes |
| "October spend summary", "breakdown by vendor for Q3" | `spend_summary`: totals, counts and change versus the previous period, by category, founder, vendor or payment method | Yes |
| "Who owes whom for October?" | `reimbursement_settlement`: what the company owes each founder, with line items | Yes |
| "Which subscriptions are we paying for?" | `detect_subscriptions`: numbered candidates from the last 6 months of the spend log; nothing is added until a founder replies "track 1 and 3" | Yes |
| "Track Notion Plus, ₹800 a month, renews 3 Dec" | `add_subscriptions` (S&lt;id&gt; references) | No |
| "What renews in the next 30 days?" | `list_subscriptions`: renewal radar with the annualized cost | No |
| "Notion went up to ₹1,000", "cancel S3" | `update_subscription` on an S&lt;id&gt; the founder named or that was just listed | No |
| "₹20k travel and ₹40k SaaS budget for November" | `set_budgets` (bulk, per spend-log category) | No |
| "How are we doing against budget?" | `budget_status`: actual versus budget per category, percent used, left or over | Actuals only |

Roll-ups, settlements, detection, budget status and every write reply with text Patch computes from stored data, not model prose. Totals are summed in whole paise.

## How the numbers work

- **Periods.** A past month is compared with the month before it. The current month runs to today and is compared with the same days of the previous month. A custom range is compared with the equal-length window just before it. Ranges are capped at one year.
- **Reimbursements.** An entry counts when it is marked Reimbursable and was not paid with a company payment method. An entry with no payment method counts as personal. Reimbursable entries paid with a company method are left out and counted in a footnote.
- **Subscription detection.** Patch groups the last 6 months by vendor (or by spend title when the vendor is blank). It keeps charges within 10% of that vendor's median amount and looks for a monthly or quarterly rhythm. Vendors that are already tracked, or that last charged more than two cycles ago, are skipped.
- **Renewals.** When a renewal date passes, Patch moves it forward by whole cycles the next time subscriptions are listed or that subscription is updated. Each move is audited with the actor `Patch`.
- **Audit.** Every subscription and budget change is written to `audit_events` with the actor and before/after values. Deletes are soft.

## Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `FINANCE_COMPANY_PAYMENT_METHODS` | `Company card` | Comma-separated spend-log payment methods that spend company money. Must be from: Company card, Personal card, UPI, Bank transfer, Cash. |

The spend-log tools appear only when `NOTION_API_KEY` and `NOTION_SPEND_DATA_SOURCE_ID` are set. Subscriptions and budgets need only D1.

## Limitations

- Patch does not track whether a reimbursement has been paid back. Settlement reports what the spend log says for the period you ask about.
- Bills in another currency are not converted; Patch asks for the INR amount.
- Roll-ups read up to 5,000 spend-log rows per request and say so when a result is partial.
- Yearly subscriptions cannot be detected from 6 months of history; add them by hand.
- Joint payments (several people in "Paid by") are reported under a combined name such as "Sagnik & Tanvi" and are not split.
- Monthly renewals on the 29th to 31st can drift to an earlier day after a short month once the rolled date is saved.
- "S3" right after "AWS" or "Amazon" is not read as a subscription id.
- Patch gives no tax, investment or accounting advice.
