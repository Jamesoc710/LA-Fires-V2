# LA Fires Project Assistant

A Next.js chat assistant for LA County parcel research, zoning, and building
codes. Users ask about an address or APN/AIN and the assistant looks up the
parcel, determines jurisdiction, and pulls zoning, overlay, and assessor data
from LA County/city GIS services, then summarizes it with an LLM.

## Technology Stack

- **Framework**: Next.js 15.3.6 (App Router)
- **Frontend**: React 19
- **LLM**: [OpenRouter](https://openrouter.ai) (not the Google Gemini SDK — the
  `@google/generative-ai` package has been removed). Primary/fallback model
  slugs are configurable via env vars.
- **GIS data**: LA County ArcGIS/ZNET/GISNET REST services, queried server-side
  via `lib/la/`
- **Language**: TypeScript 5 (strict)
- **Styling**: TailwindCSS 4
- **UI Components**: Heroicons
- **Markdown Rendering**: react-markdown + remark-gfm
- **Hosting**: Vercel

## Project Structure

```
gemini-chatbot/
├── app/
│   ├── api/chat/route.ts     # Main chat API: intent detection, ArcGIS
│   │                          # lookups, OpenRouter calls
│   ├── chat/page.tsx          # Chat page route
│   ├── components/Chat.tsx    # Chat UI (client component)
│   ├── landing/page.tsx       # Landing page
│   ├── types/chat.ts          # Chat message types
│   ├── utils/contextLoader.ts # Loads context/ files + municode lookups
│   └── layout.tsx             # Root layout (Inter font)
├── lib/la/                    # LA County domain logic
│   ├── endpoints.ts           # Env-driven registry of ArcGIS endpoints
│   ├── fetchers.ts            # Parcel/zoning/overlay/assessor lookups
│   ├── providers.ts           # Per-city zoning provider config + lookup
│   ├── cache.ts                # In-memory TTL caches for ArcGIS responses
│   ├── fieldNormalizer.ts     # Normalizes raw zoning fields for display
│   ├── rateLimit.ts           # Simple in-memory rate limiter
│   ├── logger.ts              # Structured request logging
│   └── types.ts               # Shared domain types
├── context/                   # Knowledge base text files (building code,
│                                fire safety) loaded into the LLM prompt
├── public/                    # Static assets
├── next.config.ts
└── tsconfig.json
```

## How it works

1. The user sends a message from `/chat`, which posts to `app/api/chat/route.ts`.
2. The route loads local knowledge-base context (`context/*.txt`) plus any
   relevant municode excerpts.
3. If the message looks like it references a parcel (an APN/AIN in `1234-567-890`
   format, a bare 10-digit APN paired with a keyword like "APN"/"assessor", or
   a street address), the route resolves the parcel via LA County's ArcGIS
   services, determines jurisdiction (city vs. unincorporated county), and
   fetches zoning, overlay, and assessor data — using per-city providers from
   `CITY_PROVIDERS_JSON` when the parcel falls inside an incorporated city.
4. ArcGIS responses are cached in-memory (`lib/la/cache.ts`) with per-dataset
   TTLs to reduce redundant lookups.
5. The combined context (knowledge base + tool results) and conversation are
   sent to an LLM via OpenRouter, with automatic retry and fallback to a
   secondary model.
6. The response streams back to the client and renders as Markdown.

## Environment Variables

```
# Required
OPENROUTER_API_KEY=...            # OpenRouter API key

# Optional — model overrides (defaults are set in app/api/chat/route.ts)
OR_PRIMARY_MODEL=google/gemini-3.1-flash-lite
OR_FALLBACK_MODEL=anthropic/claude-sonnet-4.6

# Optional — LA County ArcGIS endpoints (parcel/zoning/overlay/assessor lookups
# are skipped or degraded gracefully if these are unset)
ZNET_ADDRESS_SEARCH=...
GISNET_PARCEL_QUERY=...
ASSESSOR_PARCEL_QUERY=...
JURISDICTION_QUERY=...
OVERLAY_QUERY_1..OVERLAY_QUERY_6=...
FIRE_HAZARD_ZONES_QUERY=...
HILLSIDE_OVERLAY_QUERY=...
FLOOD_100YR_QUERY=...
FAULT_ZONE_QUERY=...
LIQUEFACTION_ZONE_QUERY=...
LANDSLIDE_ZONE_QUERY=...
TSUNAMI_ZONE_QUERY=...
COASTAL_ZONE_QUERY=...

# Optional — per-city zoning/overlay providers, JSON-encoded
# (see lib/la/providers.ts for the CityProvider shape)
# Configured cities: Los Angeles, Pasadena, Malibu, Santa Monica, Arcadia
CITY_PROVIDERS_JSON={"Pasadena": {...}}
```

## Setup

1. **Install dependencies**
   ```bash
   npm install
   ```

2. **Set up environment variables**
   Create `.env.local` with at least `OPENROUTER_API_KEY` (GIS lookups are
   optional but recommended — see above).

3. **Run the development server**
   ```bash
   npm run dev
   ```

4. **Lint, typecheck, build**
   ```bash
   npx next lint
   npx tsc --noEmit
   npm run build
   ```

5. **Start the production server**
   ```bash
   npm start
   ```

## Deployment

Deployed on Vercel. Push to a connected branch for a preview deployment;
merging/pushing to `main` deploys production. Set the environment variables
above in the Vercel project settings.
