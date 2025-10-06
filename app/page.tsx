import { ChatbotWidget } from "@/components/chatbot-widget"
import { Footer } from "@/components/footer"

export default function Home() {
  return (
    <div className="min-h-screen flex flex-col bg-[#E8F1F8]">
      {/* Header */}
      <header className="bg-[#0066B3] text-white py-3 px-6">
        <div className="container mx-auto flex items-center gap-3 ml-2.5">
          <img src="/neu_panda-modified.png" alt="Logo Đại học Kinh tế Quốc dân" className="w-12 h-12 object-contain" />
          <h1 className="text-lg font-semibold">Đại học Kinh tế Quốc dân</h1>
        </div>
      </header>

      {/* Main Content - Blank white area */}
      <main className="flex-1 bg-white">{/* Empty content area */}</main>

      <div className="fixed bottom-[170px] right-[54px] z-50">
        <ChatbotWidget />
      </div>

      <Footer />
    </div>
  )
}
