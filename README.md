# Web AI Course 2

Dự án web application sử dụng React cho trang web Course.

## Cài đặt

### 1. Clone repository

```bash
git clone https://github.com/son110904/web-AI-course2.git
cd web-AI-course2
```

### 2. Cài đặt dependencies và thiết lập client
```bash
cd client
```

Sử dụng npm:
```bash
npm install
```

Hoặc sử dụng yarn:
```bash
yarn install
```

## 💻 Chạy ứng dụng

### Môi trường Development

```bash
npm run dev
```

Ứng dụng sẽ chạy tại [http://localhost:3000](http://localhost:3000) (hoặc cổng được cấu hình trong dự án)

### 3. Thiết lập API 
Sử dụng npm:

```bash
cd api
npm install
```

Start infrastructure (Hãy tải phần mềm docker desktop, bật lên rồi chạy lệnh dưới)
```bash
docker-compose up -d 
```
Thiết lập OpenAI (sửa `api/.env`):
- `OPENAI_API_KEY=...`
- (tuỳ chọn) `OPENAI_CHAT_MODEL=gpt-4o-mini`

Start API (Hệ thống tự động ingest dữ liệu từ MinIO, sau đó tiến hành embedding)
```bash
npm run dev
```

