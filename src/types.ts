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

export interface BrainDumpResult {
  pageId: string;
  markdown: string;
  truncated: boolean;
}
