/**
 * The `@patch setup` interview: who someone is, what they own, who they
 * write to, and exactly how they write. Answers become notes; samples become
 * the examples drafts are matched against. `probe` questions may get one
 * follow-up when the answer is too vague to write from.
 */
export interface SetupQuestion {
  key: string;
  section: "You" | "How you write" | "Samples" | "Working with Patch";
  text: string;
  /** Samples are kept verbatim as writing examples; answers are notes. */
  kind: "answer" | "sample";
  probe: boolean;
  /** Copied into the profile as is. */
  profileField?: "role" | "focus";
}

/** The setup answer that says how Patch should talk to this person. */
export const PATCH_TONE_TOPIC = "patch_tone";

export const SETUP_QUESTIONS: readonly SetupQuestion[] = [
  {
    key: "role",
    section: "You",
    text: "What's your role at Autter, and what do you personally own day to day?",
    kind: "answer",
    probe: true,
    profileField: "role",
  },
  {
    key: "focus",
    section: "You",
    text: "What are you most focused on this quarter? What should I never let slip for you?",
    kind: "answer",
    probe: false,
    profileField: "focus",
  },
  {
    key: "audiences",
    section: "You",
    text: "Who do you write to most outside the team: investors, customers and pilots, candidates, vendors, the CA? Name a few people or companies if you like.",
    kind: "answer",
    probe: false,
  },
  {
    key: "three_words",
    section: "How you write",
    text: "Describe how you write in three words. How would a colleague describe your emails?",
    kind: "answer",
    probe: true,
  },
  {
    key: "openings",
    section: "How you write",
    text: "How do you open an email: \"Hi Rahul,\", \"Hey Rahul\", \"Rahul —\", or straight into it? Does it change for an investor versus someone you know well?",
    kind: "answer",
    probe: false,
  },
  {
    key: "signoff",
    section: "How you write",
    text: "How do you sign off (\"Best,\", \"Cheers\", \"Thanks!\", just your name, nothing)? Which name do you sign with?",
    kind: "answer",
    probe: false,
  },
  {
    key: "length",
    section: "How you write",
    text: "Short and punchy, or detailed? Bullet points or paragraphs? Roughly how long is a typical email of yours?",
    kind: "answer",
    probe: false,
  },
  {
    key: "language",
    section: "How you write",
    text: "Which languages do you mix, and with whom? English only, Hinglish with the team, Hindi with some people?",
    kind: "answer",
    probe: false,
  },
  {
    key: "emoji",
    section: "How you write",
    text: "Emojis and exclamation marks: never, sometimes, a lot? Different on WhatsApp than in email?",
    kind: "answer",
    probe: false,
  },
  {
    key: "formality",
    section: "How you write",
    text: "From 1 (very casual) to 5 (very formal), how formal are you with investors, customers, candidates, vendors and the team?",
    kind: "answer",
    probe: false,
  },
  {
    key: "phrases_use",
    section: "How you write",
    text: "Which words or phrases do you use a lot? The ones people would recognise as yours.",
    kind: "answer",
    probe: true,
  },
  {
    key: "phrases_avoid",
    section: "How you write",
    text: "Which phrases would you never write, or make you cringe in AI-written email? (\"I hope this finds you well\", \"circle back\", \"delighted to\"…)",
    kind: "answer",
    probe: false,
  },
  {
    key: "pushback",
    section: "How you write",
    text: "How do you say no or push back? Write the actual line you'd send, for example turning down a vendor or a meeting.",
    kind: "answer",
    probe: true,
  },
  {
    key: "nudge",
    section: "How you write",
    text: "Someone hasn't replied in a week. Write the nudge you'd send them.",
    kind: "answer",
    probe: true,
  },
  {
    key: "bad_news",
    section: "How you write",
    text: "How do you deliver bad news, like a delay to a customer or a rejection to a candidate? A line or two as you'd write it.",
    kind: "answer",
    probe: true,
  },
  {
    key: "thanks",
    section: "How you write",
    text: "And how do you thank someone or celebrate a win? Write it as you would.",
    kind: "answer",
    probe: false,
  },
  {
    key: "sample_investor",
    section: "Samples",
    text: "Paste or screenshot an email you sent to an investor or advisor that sounds like you. Say skip if you don't have one handy.",
    kind: "sample",
    probe: false,
  },
  {
    key: "sample_customer",
    section: "Samples",
    text: "Now one you sent to a customer, pilot or partner.",
    kind: "sample",
    probe: false,
  },
  {
    key: "sample_other",
    section: "Samples",
    text: "And one to a candidate, vendor or teammate. A WhatsApp message counts too.",
    kind: "sample",
    probe: false,
  },
  {
    key: "draft_style",
    section: "Working with Patch",
    text: "When I draft for you, do you want one ready-to-send version or two options (say, warm and crisp)? With a subject line?",
    kind: "answer",
    probe: false,
  },
  {
    key: PATCH_TONE_TOPIC,
    section: "Working with Patch",
    text: "How should I talk to you in the group: straight to the point, friendly, or with a bit of banter? Anything I should never joke about?",
    kind: "answer",
    probe: false,
  },
  {
    key: "never",
    section: "Working with Patch",
    text: "Anything I should never do or assume when writing as you?",
    kind: "answer",
    probe: false,
  },
  {
    key: "anything_else",
    section: "Working with Patch",
    text: "Last one: anything else about you or how you talk that would help? Pet peeves, running jokes, how you address your cofounder or the team.",
    kind: "answer",
    probe: false,
  },
];
