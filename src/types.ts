// Core shared types. Message/Block shapes follow the Anthropic wire format;
// the OpenAI adapter converts to/from it.

export type TextBlock = { type: 'text'; text: string };
export type ToolUseBlock = { type: 'tool_use'; id: string; name: string; input: Record<string, any> };
export type ToolResultBlock = { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };
export type Block = TextBlock | ToolUseBlock | ToolResultBlock;

export interface Message {
  role: 'user' | 'assistant';
  content: Block[];
}

export interface ToolSpec {
  name: string;
  description: string;
  input_schema: Record<string, any>;
}

export interface Usage {
  input: number;
  output: number;
}

export interface CompletionRequest {
  model: string;
  system: string;
  messages: Message[];
  tools: ToolSpec[];
  maxTokens: number;
  signal?: AbortSignal;
  onText?: (text: string) => void;
}

export interface CompletionResult {
  content: Block[];
  stopReason: 'end' | 'tool_use' | 'max_tokens';
  usage: Usage;
}

export interface Provider {
  name: string;
  defaultModel: string;
  complete(req: CompletionRequest): Promise<CompletionResult>;
}

export interface Todo {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export interface PlanStep {
  title: string;
  detail?: string;
}

export interface Plan {
  summary: string;
  steps: PlanStep[];
  verify_commands?: string[];
}

/** What a tool can do to the agent that invoked it. */
export interface ToolContext {
  cwd: string;
  signal?: AbortSignal;
  agentId: string;
  setTodos(todos: Todo[]): void;
  setPlan(plan: Plan): void;
  requestStop(): void;
}

export interface Tool {
  spec: ToolSpec;
  /** Read-only tools never need permission and may run in parallel. */
  readOnly: boolean;
  /** 'edit' tools are auto-approved in auto-edit mode; 'exec' tools always ask unless yolo. */
  kind?: 'edit' | 'exec' | 'other';
  describe(input: Record<string, any>): string;
  run(input: Record<string, any>, ctx: ToolContext): Promise<string>;
}
