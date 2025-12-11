

export type MessageRole = 'user' | 'assistant' | 'system';

// FIX #38: Message metadata for timestamps and other info
export interface MessageMetadata {
  /** ISO timestamp when data was retrieved */
  queriedAt?: string;
  /** Detected jurisdiction for the parcel */
  jurisdiction?: string;
  /** Data sources used (for attribution) */
  sources?: string[];
}

export interface Message {
  role: MessageRole;
  content: string;
  id?: string;

  metadata?: MessageMetadata;
}

export interface ChatState {
  messages: Message[];
  isLoading: boolean;
  error: string | null;
}

export interface ChatContextType {
  state: ChatState;
  sendMessage: (message: string) => Promise<void>;
  resetChat: () => void;
}
