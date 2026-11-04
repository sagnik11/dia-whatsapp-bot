# Setup and writing in each person's voice

Everyone on the allowlist gets a profile: who they are, what they own, and how they write. Patch builds it from a short interview, then keeps learning. When anyone asks for a draft, Patch writes it as the person it is from, in their words, not in Patch's harbour-master voice.

Nothing here needs configuration. It uses the same D1 database as tasks (tables `people`, `person_ids` and `person_notes`, see `migrations/0008_people.sql`).

## `@patch setup`

Each person sends `@patch setup` in the group. Patch then asks 22 questions, one at a time, addressed to that person:

| Section | What it asks |
| --- | --- |
| You | Role and what they own, this quarter's focus, who they write to outside the team |
| How you write | Three words for their style, openings, sign-offs and the name they sign with, length, language mix (Hinglish, Hindi), emoji, formality by audience, phrases they use and avoid, how they push back, nudge, give bad news and say thanks |
| Samples | An email to an investor or advisor, one to a customer or partner, one to a candidate, vendor or teammate |
| Working with Patch | One draft or two options, subject lines, anything never to do, anything else |

Each question looks like this:

```text
📝 Setup · Tanvi · Q4/22

*How you write*
Describe how you write in three words. How would a colleague describe your emails?

_Reply to this message to answer. skip · back · pause setup_
```

- **Answering.** Reply to the question (swipe right on it); no `@patch` needed. `@patch <answer>` works too. Voice notes are transcribed, and screenshots or PDFs of emails are read, so samples can be screenshots.
- **Follow-ups.** For a few questions, when an answer is vague, Patch asks one follow-up, usually for an example line in the person's own words.
- **Moving around.** `skip`, `back`, `pause setup`, and `done` to finish early. Replying to an earlier question changes that answer. `@patch setup` resumes after a pause; `@patch setup again` starts over.
- **Only your own interview.** A reply to someone else's question is ignored. Mid-interview, a tagged request such as `@patch add a task…`, or a message quoting something else, is handled as usual.
- **At the end** Patch builds the person's voice guide and shows it.

## Drafting

Paste or forward an email, quote it, or send a screenshot or PDF, then ask:

- `@patch reply to this in my tone`
- `@patch draft a nudge to the designer about the landing page`
- `@patch write to our CA in Tanvi's voice asking where the GST filing is`

Before any draft, Patch reads the sender's voice: the guide, their rules, lessons, and up to three samples (matched to the audience when it can tell). Rules override the guide. The draft is ready to send, with a subject line for a new email, unless the person asked for something else in setup. Missing facts become `[placeholders]`; Patch does not invent dates or numbers. Someone without a profile gets a plain draft and a one-line nudge to run setup.

## How Patch keeps learning

| Source | When | Kept as |
| --- | --- | --- |
| Corrections ("too formal", "I never say Dear", "sign as T") | Immediately, `save_voice_rules` | Rules (`V<id>`), which override everything |
| The version you actually sent ("here's what I sent instead: …") | Immediately, `learn_from_final` | A sample, plus the differences from Patch's draft as lessons |
| Your messages in the group | Every 6 hours, from the conversation log | Up to 30 chat-style observations |

The voice guide is rebuilt from all of these in the background when something changes, and right after setup. Group messages shorter than 20 characters are ignored, and a person needs at least 8 new ones before Patch looks; it reads at most the last week the first time.

## Each person controls their own profile

| Say | Does |
| --- | --- |
| `@patch show my profile` | Role, focus, voice guide, rules and lessons with `V<id>` refs, setup progress |
| `@patch update my role: …` | Changes role, focus or the about line |
| `@patch forget V12` | Removes that rule or lesson |
| `@patch delete my profile` | Erases the profile, answers, samples, rules and voice guide |

Rules, lessons and profile changes only ever apply to the person asking. Anyone can ask for a draft in a teammate's voice, but only that teammate can change it. Deleting a profile needs the person's own words in their message, so an instruction inside a quoted message cannot trigger it.

## Adding a teammate

Add their WhatsApp ids to `AUTHORIZED_USER_IDS` (see the allowlist steps in [DEPLOYMENT.md](DEPLOYMENT.md#4-whatsapp-pairing-and-allowlists)) and recreate the container. They get Patch exactly as founders do, then run `@patch setup`.
