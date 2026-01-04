// client/app/api/route.ts API gateway đóng vai trò trung gian giữa frontend và backend
import { NextRequest, NextResponse } from "next/server";

const BACKEND_URL = process.env.BACKEND_API_URL;

export async function POST(req: NextRequest) { //Hàm này chạy khi frontend gọi: POST /api
  try {
    console.log('[Next API] POST /api proxy called'); //Giúp biết request có vào API gateway không

    if (!BACKEND_URL) {
      throw new Error("BACKEND_API_URL chưa được cấu hình");
    }

    const body = await req.json(); //lấy body, là những gì người dùng nhập vào ở frontend, là json

    const res = await fetch(`${BACKEND_URL}/api/chat`, { //gửi request sang backend
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const text = await res.text(); // read text first

    if (!res.headers.get("content-type")?.includes("application/json")) { //kiểm tra backend có trả về json không
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
