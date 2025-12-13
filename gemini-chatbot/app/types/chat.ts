

export type Message = {
  role: 'user' | 'assistant';
  content: string;
  metadata?: {
    queriedAt?: string;
    jurisdiction?: string;
    sources?: string[];
    type?: string; // 'address_picker' when returning multiple address matches
  };
};


export type AddressMatch = {
  address: string;
  city: string;
  zip: string;
  apn: string;
};

export type ChatResponse = {
  response: string;
  intent?: string;
  addressMatches?: AddressMatch[];
  resolvedAddress?: {
    address: string;
    apn: string;
  };
  metadata?: {
    queriedAt?: string;
    jurisdiction?: string;
    sources?: string[];
    type?: string;
  };
};
