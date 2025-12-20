import type React from "react"
import type { Metadata } from "next"
import { Barlow } from "next/font/google"
import { Suspense } from "react"
import "./globals.css"

const barlow = Barlow({
  weight: ["300", "400", "500", "600", "700"],
  subsets: ["latin", "vietnamese"],
  variable: "--font-barlow",
})

export const metadata: Metadata = {
  title: "Courses AIChatbot - Đại học Kinh tế Quốc dân",
  description: "Trợ lý ảo thông minh cho sinh viên và giảng viên",
  generator: "v0.app",
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="vi">
      <body className={`${barlow.variable} font-sans antialiased`}>
        <Suspense fallback={<div>Loading...</div>}>{children}</Suspense>
        {/* Analytics component removed */}
      </body>
    </html>
  )
}
