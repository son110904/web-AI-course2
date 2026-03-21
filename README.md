# Web AI Course 2

Ban nay chay truc tiep tren CLI, khong can giao dien va khong dung endpoint HTTP.

## Chay CLI

```bash
cd api
py -3 -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
py -3 main.py
```

Lenh trong CLI:
- `/reset`: xoa lich su chat
- `/status`: xem tong so document/chunk trong Qdrant
- `/ingest`: quet MinIO va ingest file moi vao Qdrant (neu da cau hinh MINIO)
- `/ingest --force`: ingest lai tat ca file tim thay trong MinIO
- `/exit` hoac `/quit`: thoat

## Bien moi truong bat buoc

File `api/.env` can toi thieu:
- `QDRANT_URL`
- `QDRANT_COLLECTION`
- `OPENAI_API_KEY`

Neu muon ingest tu MinIO, can them:
- `MINIO_ENDPOINT`
- `MINIO_PORT`
- `MINIO_ACCESS_KEY`
- `MINIO_SECRET_KEY`
- `MINIO_BUCKET_NAME`
- `MINIO_USE_SSL` (tuy chon, mac dinh `false`)
- `MINIO_BASE_PREFIX` (tuy chon, mac dinh `rag-processed`)

Neu `/ingest` bao loi ket noi MinIO:
- Kiem tra dung API port cua MinIO (thuong la `9000`, khong phai console port).
- Neu dung HTTPS (`MINIO_USE_SSL=true`), nen dat `MINIO_ENDPOINT` la domain khop chung chi SSL (khong nen dung IP).
