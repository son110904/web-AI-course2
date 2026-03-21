from __future__ import annotations

from io import BytesIO

from minio import Minio


class MinIOModel:
    def __init__(self, *, endpoint: str, port: int, access_key: str, secret_key: str, bucket: str, use_ssl: bool = False) -> None:
        self.client = Minio(
            endpoint=f"{endpoint}:{port}",
            access_key=access_key,
            secret_key=secret_key,
            secure=use_ssl,
        )
        self.bucket = bucket

    def list_files(self, prefix: str) -> list[str]:
        objects = self.client.list_objects(self.bucket, prefix=prefix, recursive=True)
        return [obj.object_name for obj in objects if obj.object_name]

    def get_file(self, object_name: str) -> bytes:
        response = self.client.get_object(self.bucket, object_name)
        try:
            stream = BytesIO(response.read())
            return stream.getvalue()
        finally:
            response.close()
            response.release_conn()
