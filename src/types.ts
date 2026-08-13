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
}

export interface TaskInput {
  title: string;
  dueAt: string | null;
  assignee: string | null;
  priority: "High" | "Med" | "Low" | null;
  taskType: "Tech" | "Marketing" | "Content" | "Misc" | "Product" | null;
  notes: string | null;
}

export interface TaskSource {
  groupName: string;
  messageId: string;
  requestedBy: string;
}

export interface TaskResult {
  id: string;
  url: string | null;
  title: string;
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

export interface TaskQuery {
  titleContains: string | null;
  status: string | null;
  dueFrom: string | null;
  dueTo: string | null;
  limit: number;
}

export interface TaskSummary {
  id: string;
  url: string;
  title: string;
  status: string | null;
  dueAt: string | null;
  assignees: string[];
  priority: string | null;
  taskTypes: string[];
}

export interface TaskListResult {
  tasks: TaskSummary[];
  hasMore: boolean;
}

export interface TaskUpdateInput {
  pageId: string;
  title: string;
  newTitle: string | null;
  status: string | null;
  dueAt: string | null;
  assignee: string | null;
  priority: string | null;
  taskTypes: string[] | null;
  clearFields: Array<"due_date" | "assignee" | "priority" | "task_type">;
  pageContentMode: "append" | "replace" | null;
  pageContent: string | null;
}

export interface TaskUpdateResult {
  id: string;
  url: string | null;
  title: string;
  status: string | null;
  dueAt: string | null;
  assignee: string | null;
  priority: string | null;
  taskTypes: string[] | null;
  clearedFields: Array<"due_date" | "assignee" | "priority" | "task_type">;
  pageContentMode: "append" | "replace" | null;
}

export interface TaskCommentSummary {
  id: string;
  author: string;
  createdAt: string;
  text: string;
}

export interface TaskAttachmentResult {
  pageId: string;
  fileName: string;
  fileUploadId: string;
}

export interface TaskPageResult {
  pageId: string;
  title: string;
  markdown: string;
  truncated: boolean;
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
