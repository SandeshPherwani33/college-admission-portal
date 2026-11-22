from __future__ import annotations

import os
import re
import tempfile
from pathlib import Path


_DOCUMENT_ID_PATTERN = re.compile(r"doc-[a-f0-9]{32}\Z")


class LocalDocumentStorage:
    def __init__(self, root: Path | str, *, create_root: bool = True) -> None:
        self.root = Path(root)
        self.create_root = create_root

    def _ensure_root(self) -> Path:
        if self.root.is_symlink():
            raise RuntimeError("Document storage directory must not be a symbolic link.")
        resolved_root = self.root.expanduser().resolve()
        frontend_root = Path(__file__).resolve().parents[3] / "frontend"
        resolved_frontend_root = frontend_root.resolve()
        if (
            resolved_root == resolved_frontend_root
            or resolved_frontend_root in resolved_root.parents
        ):
            raise RuntimeError("Document storage must be outside the frontend directory.")
        if not self.root.exists():
            if not self.create_root:
                raise RuntimeError("Configured document storage directory is unavailable.")
            self.root.mkdir(parents=True, exist_ok=True)
        if self.root.is_symlink() or not self.root.is_dir():
            raise RuntimeError("Document storage directory is not a private directory.")
        resolved_root = self.root.resolve()
        if os.name != "nt":
            resolved_root.chmod(0o700)
        return resolved_root

    def ensure_available(self) -> None:
        root = self._ensure_root()
        try:
            with tempfile.NamedTemporaryFile(dir=root, prefix=".storage-check-", delete=True):
                pass
        except OSError as exc:
            raise RuntimeError("Configured document storage directory is not writable.") from exc

    def _path_for(self, document_id: str) -> Path:
        if not _DOCUMENT_ID_PATTERN.fullmatch(document_id):
            raise ValueError("Invalid document ID.")
        root = self._ensure_root()
        path = root / f"{document_id}.bin"
        if path.parent != root or path.is_symlink():
            raise RuntimeError("Invalid document storage path.")
        return path

    def save(self, document_id: str, content: bytes) -> str:
        path = self._path_for(document_id)
        created = False
        try:
            with path.open("xb") as document_file:
                created = True
                if os.name != "nt":
                    os.chmod(path, 0o600)
                document_file.write(content)
        except OSError:
            if created:
                path.unlink(missing_ok=True)
            raise
        return document_id

    def get_path(self, document_id: str) -> Path | None:
        path = self._path_for(document_id)
        return path if path.is_file() else None

    def delete(self, document_id: str) -> None:
        path = self._path_for(document_id)
        path.unlink(missing_ok=True)


def get_document_storage() -> LocalDocumentStorage:
    from app.core.config import get_settings

    settings = get_settings()
    root = settings.document_storage_dir
    if root is None:
        if settings.app_env == "production":
            raise RuntimeError("DOCUMENT_STORAGE_DIR is required in production.")
        root = Path(__file__).resolve().parents[2] / "private_documents"
    elif settings.app_env == "production" and not Path(root).is_absolute():
        raise RuntimeError("Production DOCUMENT_STORAGE_DIR must be an absolute path.")
    return LocalDocumentStorage(root, create_root=settings.app_env != "production")
