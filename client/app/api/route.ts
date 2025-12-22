// client/app/api/route.ts
import { NextRequest, NextResponse } from "next/server";

const BACKEND_URL = process.env.BACKEND_API_URL;

export async function POST(req: NextRequest) {
  try {
    console.log('[Next API] POST /api proxy called');

    if (!BACKEND_URL) {
      throw new Error("BACKEND_API_URL chưa được cấu hình");
    }

    const body = await req.json();

    const res = await fetch(`${BACKEND_URL}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const text = await res.text(); // read text first

    if (!res.headers.get("content-type")?.includes("application/json")) {
      console.error("Backend returned non-JSON:", text.slice(0, 300));
      return NextResponse.json(
        { botMessage: "Backend lỗi hoặc không trả JSON", detail: text.slice(0, 200) },
        { status: 500 }
      );
    }

    const data = JSON.parse(text);
    return NextResponse.json(data, { status: res.status });

  } catch (error: any) {
    console.error("API proxy error:", error);
    return NextResponse.json(
      { botMessage: "Xin lỗi, hệ thống đang gặp lỗi. Vui lòng thử lại.", detail: error.message },
      { status: 500 }
    );
  }
}

export async function GET() {
  console.log('[Next API] GET /api');
  return NextResponse.json({ message: "API gateway đang chạy" });
}
