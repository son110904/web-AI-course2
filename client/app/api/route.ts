// client/app/api/route.ts
import { NextRequest } from "next/server";

const BACKEND_URL = process.env.BACKEND_API_URL;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    const res = await fetch(`${BACKEND_URL}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const data = await res.json();

    return Response.json(data, { status: res.status });
  } catch (error) {
    console.error("API proxy error:", error);
    return Response.json(
      { botMessage: "Xin lỗi, hệ thống đang gặp lỗi. Vui lòng thử lại." },
      { status: 500 }
    );
  }
}

export async function GET() {
  return Response.json({ message: "API gateway đang chạy" });
}
