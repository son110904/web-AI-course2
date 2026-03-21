# Web AI Course 2

Du an gom 2 phan chay doc lap:
- `client/`: Next.js frontend
- `api/`: Python FastAPI backend

## 1) Chay backend (Python)

```bash
cd api
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
python main.py
```

Backend chay tai: `http://localhost:4000`

Health check:
- `GET http://localhost:4000/health`

Chat endpoint:
- `POST http://localhost:4000/api/demo_agent/v1/ask`

## 2) Chay frontend (Next.js)

```bash
cd client
npm install
npm run dev
```

Frontend chay tai: `http://localhost:3000`

## Cau hinh frontend goi backend

File `client/.env.local`:

```env
NEXT_PUBLIC_BACKEND_API_URL=http://localhost:4000
```

Frontend goi truc tiep backend qua URL tren (khong dung proxy API route nua).

## Bien moi truong backend

File `api/.env` can toi thieu:
- `PORT`
- `QDRANT_URL`
- `QDRANT_COLLECTION`
- `OPENAI_API_KEY`

Neu su dung MinIO ingest them:
- `MINIO_ENDPOINT`
- `MINIO_PORT`
- `MINIO_ACCESS_KEY`
- `MINIO_SECRET_KEY`
- `MINIO_BUCKET_NAME`
