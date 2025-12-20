// app/api/chat/route.ts
import { NextRequest } from "next/server";
import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export async function POST(req: NextRequest) {
  try {
    const { messages } = await req.json();

    if (!messages || !Array.isArray(messages)) {
      return Response.json({ botMessage: "Dữ liệu không hợp lệ." }, { status: 400 });
    }

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "Bạn là Courses AIChatbot – trợ lý ảo thông minh của Đại học Kinh tế Quốc dân (NEU). " +
            "Bạn chuyên hỗ trợ về chương trình đào tạo, đề cương môn học, tuyển sinh, học phí, lịch học... " +
            "Trả lời ngắn gọn, thân thiện, chính xác bằng tiếng Việt.",
        },
        ...messages,
      ],
      temperature: 0.7,
      max_tokens: 800,
    });

    const botMessage = completion.choices[0]?.message?.content?.trim() || "Mình chưa hiểu câu hỏi, bạn nói rõ hơn nhé!";

    return Response.json({ botMessage });
  } catch (error: any) {
    console.error("OpenAI error:", error);
    return Response.json(
      { botMessage: "Xin lỗi, mình đang gặp lỗi kỹ thuật. Thử lại sau vài phút nhé!" },
      { status: 500 }
    );
  }
}

export async function GET() {
  return Response.json({ message: "Chat API đang chạy" });
}