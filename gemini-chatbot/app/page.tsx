import Chat from './components/Chat';

export default function Home() {
  return (
    <main className="flex min-h-screen flex-col">
      <header className="bg-blue-600 text-white p-4 shadow-md">
        <h1 className="text-xl font-bold">LA Building Codes Assistant</h1>
        <p className="text-sm">Powered by Google Gemini</p>
      </header>
      
      <div className="flex-1">
        <Chat />
      </div>
    </main>
  );
}
