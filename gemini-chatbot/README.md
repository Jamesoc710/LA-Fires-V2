# LA Fire Safety Chatbot

A simple chatbot application built with Next.js and Google Gemini API that provides information about Los Angeles fires and fire safety.

## Features

- Chat interface with Google Gemini AI backend
- Static context from text files
- Session-based chat history
- Responsive UI with Tailwind CSS

## Getting Started

### Prerequisites

- Node.js 18.17.0 or later
- A Google Gemini API key (get one from [Google AI Studio](https://aistudio.google.com/app/apikey))

### Installation

1. Clone the repository:

```bash
git clone <repository-url>
cd gemini-chatbot
```

2. Install dependencies:

```bash
npm install
```

3. Set up environment variables:

Create a `.env.local` file in the root directory with the following content:

```
GEMINI_API_KEY=your_gemini_api_key_here
```

Replace `your_gemini_api_key_here` with your actual Google Gemini API key.

### Running the Development Server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

## Project Structure

- `app/` - Next.js App Router
  - `components/` - React components
  - `api/` - API routes
  - `utils/` - Utility functions
  - `types/` - TypeScript type definitions
- `context/` - Static context files for the chatbot

## Customizing Context

To customize the information the chatbot uses to answer questions:

1. Add or modify text files in the `context/` directory.
2. The application will automatically load all `.txt` files from this directory.

## Deployment

This application can be easily deployed on Vercel:

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/yourusername/gemini-chatbot)

## License

[MIT](https://choosealicense.com/licenses/mit/)
