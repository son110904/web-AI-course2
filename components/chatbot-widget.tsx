"use client"

import type React from "react"
import { useState, useEffect, useRef } from "react"
import { MessageCircle, Maximize2, Send, Minus, ArrowLeft, Paperclip } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { Footer } from "@/components/footer"

type Message = {
  id: string
  text: string
  sender: "user" | "bot"
  timestamp: Date
}

export function ChatbotWidget() {
  const [isOpen, setIsOpen] = useState(false)
  const [isExpanded, setIsExpanded] = useState(false)
  const [messages, setMessages] = useState<Message[]>([])
  const [smallChatMessages, setSmallChatMessages] = useState<Message[]>([
    {
      id: "1",
      text: "Nếu có thắc mắc, hãy hỏi mình nhé!",
      sender: "bot",
      timestamp: new Date(),
    },
  ])
  const [inputValue, setInputValue] = useState("")

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const smallChatMessagesRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!isExpanded) {
      setMessages([])
    }
  }, [isExpanded])

  useEffect(() => {
    if (isExpanded && messages.length > 0) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })
    } else if (isOpen && smallChatMessagesRef.current) {
      smallChatMessagesRef.current.scrollTop = smallChatMessagesRef.current.scrollHeight
    }
  }, [messages, smallChatMessages, isExpanded, isOpen])

  const handleSend = () => {
    if (!inputValue.trim()) return

    const userMessage: Message = {
      id: Date.now().toString(),
      text: inputValue,
      sender: "user",
      timestamp: new Date(),
    }

    if (isExpanded) {
      setMessages((prev) => [...prev, userMessage])
    } else {
      setSmallChatMessages((prev) => [...prev, userMessage])
    }
    setInputValue("")

    setTimeout(() => {
      const botMessage: Message = {
        id: (Date.now() + 1).toString(),
        text: "Cảm ơn bạn đã hỏi. Tôi sẽ giúp bạn tìm thông tin.",
        sender: "bot",
        timestamp: new Date(),
      }
      if (isExpanded) {
        setMessages((prev) => [...prev, botMessage])
      } else {
        setSmallChatMessages((prev) => [...prev, botMessage])
      }
    }, 1000)
  }

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  if (isExpanded) {
    const showWelcomeScreen = messages.length === 0

    return (
      <div className="fixed inset-0 z-50 bg-white flex flex-col h-screen">
        <header className="bg-[#0066B3] text-white py-3 px-6 flex-shrink-0">
          <div className="container mx-auto flex items-center gap-3">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setIsExpanded(false)}
              className="text-white hover:bg-white/20"
              title="Quay lại"
            >
              <ArrowLeft className="h-5 w-5" />
            </Button>
            <img
              src="/neu_panda-modified.png"
              alt="Logo Đại học Kinh tế Quốc dân"
              className="w-12 h-12 object-contain"
            />
            <h1 className="text-lg font-semibold">Đại học Kinh tế Quốc dân</h1>
          </div>
        </header>

        {showWelcomeScreen ? (
          <main className="flex-1 bg-white flex items-center justify-center">
            <div className="w-full max-w-3xl mx-auto text-center space-y-8 px-6">
              <div className="space-y-4">
                <h2 className="text-5xl font-bold text-gray-900">Courses AIChatbot</h2>
                <p className="text-gray-600 text-lg">
                  Hỏi đáp về Chương trình đào tạo, đề cương,... của Đại học Kinh tế Quốc dân.
                </p>
              </div>
              <div className="flex items-center gap-3 border border-gray-300 rounded-full px-4 py-3 bg-white shadow-sm hover:shadow-md transition-shadow max-w-2xl mx-auto">
                <Button variant="ghost" size="icon" className="text-gray-500 hover:text-gray-700 h-8 w-8">
                  <Paperclip className="h-4 w-4" />
                </Button>
                <Input
                  value={inputValue}
                  onChange={(e) => setInputValue(e.target.value)}
                  onKeyPress={handleKeyPress}
                  placeholder="Hỏi Courses AIChatbot..."
                  className="flex-1 border-0 text-sm focus-visible:ring-0 focus-visible:ring-offset-0 px-0 h-8"
                />
                <Button
                  onClick={handleSend}
                  size="icon"
                  className="bg-transparent hover:bg-gray-100 text-gray-700 rounded-full h-8 w-8"
                >
                  <Send className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </main>
        ) : (
          <>
            <main className="flex-1 bg-white overflow-y-auto pb-24">
              <div className="w-full max-w-3xl mx-auto flex flex-col py-8 px-6">
                <div className="space-y-3 px-4 min-h-[200px]">
                  {messages.map((message) => (
                    <div
                      key={message.id}
                      className={cn("flex", message.sender === "user" ? "justify-end" : "justify-start")}
                    >
                      <div
                        className={cn(
                          "max-w-[70%] rounded-lg px-4 py-3",
                          message.sender === "user" ? "bg-[#0066B3] text-white" : "bg-gray-100 text-gray-900",
                        )}
                      >
                        <p className="text-sm leading-relaxed">{message.text}</p>
                      </div>
                    </div>
                  ))}
                  <div ref={messagesEndRef} />
                </div>
              </div>
            </main>

            <div
              className="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 z-10"
              style={{ bottom: "140px" }}
            >
              <div className="w-full max-w-3xl mx-auto px-6 py-3">
                <div className="flex items-center gap-3 border border-gray-300 rounded-full px-4 py-2.5 bg-white shadow-sm hover:shadow-md transition-shadow">
                  <Button variant="ghost" size="icon" className="text-gray-500 hover:text-gray-700 h-8 w-8">
                    <Paperclip className="h-4 w-4" />
                  </Button>
                  <Input
                    value={inputValue}
                    onChange={(e) => setInputValue(e.target.value)}
                    onKeyPress={handleKeyPress}
                    placeholder="Hỏi Courses AIChatbot..."
                    className="flex-1 border-0 text-sm focus-visible:ring-0 focus-visible:ring-offset-0 px-0 h-8"
                  />
                  <Button
                    onClick={handleSend}
                    size="icon"
                    className="bg-transparent hover:bg-gray-100 text-gray-700 rounded-full h-8 w-8"
                  >
                    <Send className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </div>
          </>
        )}

        <div className="flex-shrink-0">
          <Footer />
        </div>
      </div>
    )
  }

  if (isOpen) {
    return (
      <div className="fixed bottom-[170px] right-[54px] z-50 w-[280px] h-[320px] bg-white rounded-lg shadow-2xl flex flex-col overflow-hidden border border-gray-200">
        <div className="bg-[#0066B3] text-white px-3 py-2.5 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <MessageCircle className="h-4 w-4" />
            <span className="font-semibold text-sm">Courses AIChatbot</span>
          </div>
          <div className="flex items-center gap-0.5">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setIsExpanded(true)}
              className="h-7 w-7 text-white hover:bg-white/20 rounded"
              title="Mở rộng"
            >
              <Maximize2 className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setIsOpen(false)}
              className="h-7 w-7 text-white hover:bg-white/20 rounded"
              title="Thu nhỏ"
            >
              <Minus className="h-4 w-4" />
            </Button>
          </div>
        </div>

        <div ref={smallChatMessagesRef} className="flex-1 overflow-y-auto p-3 space-y-2 bg-white">
          {smallChatMessages.map((message) => (
            <div key={message.id} className={cn("flex", message.sender === "user" ? "justify-end" : "justify-start")}>
              <div
                className={cn(
                  "max-w-[85%] rounded-lg px-3 py-2",
                  message.sender === "user" ? "bg-[#0066B3] text-white" : "bg-gray-100 text-gray-900",
                )}
              >
                <p className="text-sm leading-relaxed">{message.text}</p>
              </div>
            </div>
          ))}
        </div>

        <div className="border-t bg-white p-2.5">
          <div className="flex items-center gap-2">
            <Input
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyPress={handleKeyPress}
              placeholder="Hỏi Courses AIChatbot..."
              className="flex-1 text-sm h-9 border-gray-300"
            />
            <Button onClick={handleSend} size="icon" className="bg-[#0066B3] hover:bg-[#0052A3] text-white h-9 w-9">
              <Send className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <Button
      onClick={() => setIsOpen(true)}
      className="bg-[#0066B3] hover:bg-[#0052A3] text-white rounded-full px-5 py-6 shadow-2xl flex items-center gap-2 whitespace-nowrap"
    >
      <MessageCircle className="h-5 w-5" />
      <span className="font-semibold text-sm">Courses AIChatbot</span>
    </Button>
  )
}
