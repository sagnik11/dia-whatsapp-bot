export interface BufferedMessage {
  author: string;
  body: string;
  timestamp: number;
}

export interface AssistantRequest {
  groupId: string;
  groupName: string;
  messageId: string;
  requestedBy: string;
  requestedById: string;
  body: string;
  quotedMessage: string | null;
  recentContext: BufferedMessage[];
  attachments?: AssistantAttachment[];
}

export type AssistantAttachmentKind = "audio" | "image" | "pdf" | "file";

export interface AssistantAttachment {
  kind: AssistantAttachmentKind;
  mimeType: string;
  fileName: string;
  dataBase64: string;
  sizeBytes: number;
  transcript: string | null;
  /** Markdown extracted from a PDF or document, when conversion succeeded. */
  extractedText?: string | null;
}

/** Where a Brain Dump note came from, for attribution. */
export interface NoteSource {
  groupName: string;
  messageId: string;
  requestedBy: string;
}

export type SpendCategory =
  | "Travel"
  | "Software & SaaS"
  | "Hosting & Infrastructure"
  | "Meals"
  | "Marketing"
  | "Contractors"
  | "Office"
  | "Legal & Finance"
  | "Other";

export type SpendPaymentMethod =
  | "Company card"
  | "Personal card"
  | "UPI"
  | "Bank transfer"
  | "Cash";

export interface SpendInput {
  spend: string;
  amount: number;
  date: string;
  paidBy: string;
  category: SpendCategory;
  paymentMethod: SpendPaymentMethod | null;
  vendor: string | null;
  notes: string | null;
  reimbursable: boolean;
}

export interface SpendSource {
  messageId: string;
  groupName: string;
  requestedBy: string;
}

export interface SpendWriteResult {
  index: number;
  spend: string;
  amount: number;
  date: string;
  status: "created" | "duplicate" | "failed";
  id: string | null;
  url: string | null;
  error: string | null;
}

export interface SpendBatchResult {
  paidBy: string;
  results: SpendWriteResult[];
  createdCount: number;
  duplicateCount: number;
  failedCount: number;
  createdAmount: number;
}

export interface SpendQuery {
  paidBy: string | null;
  category: SpendCategory | null;
  dateFrom: string | null;
  dateTo: string | null;
  limit: number;
}

export interface SpendSummary {
  id: string;
  url: string;
  spend: string;
  amount: number;
  date: string | null;
  paidBy: string[];
  category: string | null;
  paymentMethod: string | null;
  vendor: string | null;
  notes: string | null;
  reimbursable: boolean;
}

export interface SpendListResult {
  spends: SpendSummary[];
  hasMore: boolean;
  totalAmount: number;
}

export interface ReminderCreateInput {
  groupId: string;
  requestedBy: string;
  requestedById: string;
  sourceMessageId: string;
  message: string;
  dueAt: string;
  notifyBeforeMinutes: number;
  repeatEveryMinutes: number | null;
}

export type ReminderPhase = "pre_due" | "due" | "repeat";

export interface ReminderRecord {
  id: number;
  groupId: string;
  requestedBy: string;
  requestedById: string;
  message: string;
  dueAt: string;
  notifyBeforeMinutes: number;
  repeatEveryMinutes: number | null;
  nextFireAt: string;
  phase: ReminderPhase;
}

export interface BrainDumpResult {
  pageId: string;
  markdown: string;
  truncated: boolean;
}

export interface BrainDumpAppendInput {
  heading: string | null;
  content: string;
}

export interface BrainDumpAppendResult {
  pageId: string;
  heading: string | null;
  charactersAdded: number;
}

export interface KnowledgeSearchResult {
  id: string;
  type: "page" | "data_source";
  title: string;
  url: string | null;
  lastEditedTime: string | null;
}

export interface KnowledgeSearchResponse {
  results: KnowledgeSearchResult[];
  hasMore: boolean;
}

export interface ScriptSource {
  dataSourceId: string;
  titleProperty: string;
}

export interface ScriptLibraryEntry {
  episode: number;
  id: string;
  title: string;
  url: string;
  lastEditedTime: string;
  markdown: string;
  truncated: boolean;
}

export interface ScriptLibraryResult {
  seriesName: string;
  scripts: ScriptLibraryEntry[];
}

export interface KnowledgePageResult {
  id: string;
  type: "page";
  markdown: string;
  truncated: boolean;
}

export interface KnowledgeDataSourceRow {
  id: string;
  url: string;
  lastEditedTime: string;
  properties: Readonly<Record<string, unknown>>;
}

export interface KnowledgeDataSourceResult {
  id: string;
  type: "data_source";
  rows: KnowledgeDataSourceRow[];
  hasMore: boolean;
}

export type KnowledgeResourceResult =
  | KnowledgePageResult
  | KnowledgeDataSourceResult;
