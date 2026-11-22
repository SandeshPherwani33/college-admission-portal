from __future__ import annotations

from starlette.responses import JSONResponse


class SecurityHeadersMiddleware:
    def __init__(self, app) -> None:
        self.app = app

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def send_with_security_headers(message):
            if message["type"] == "http.response.start":
                headers = dict(message.setdefault("headers", []))
                headers.update({
                    b"x-content-type-options": b"nosniff",
                    b"x-frame-options": b"DENY",
                    b"referrer-policy": b"no-referrer",
                    b"permissions-policy": b"camera=(), microphone=(), geolocation=()",
                    b"cache-control": b"no-store",
                })
                message["headers"] = list(headers.items())
            await send(message)

        await self.app(scope, receive, send_with_security_headers)


class _UploadRequestTooLarge(Exception):
    pass


class DocumentUploadLimitMiddleware:
    def __init__(
        self,
        app,
        *,
        upload_path: str,
        max_request_bytes: int,
    ) -> None:
        self.app = app
        self.upload_path = upload_path
        self.max_request_bytes = max_request_bytes

    async def __call__(self, scope, receive, send) -> None:
        if (
            scope["type"] != "http"
            or scope["method"] != "POST"
            or scope["path"] != self.upload_path
        ):
            await self.app(scope, receive, send)
            return

        headers = {
            key.lower(): value
            for key, value in scope.get("headers", [])
        }
        content_length = headers.get(b"content-length")
        if content_length is not None:
            try:
                declared_length = int(content_length)
            except ValueError:
                response = JSONResponse(
                    status_code=400,
                    content={"detail": "Invalid Content-Length header."},
                )
                await response(scope, receive, send)
                return
            if declared_length > self.max_request_bytes:
                response = JSONResponse(
                    status_code=413,
                    content={"detail": "Multipart upload exceeds the allowed request size."},
                )
                await response(scope, receive, send)
                return

        received_bytes = 0

        async def receive_with_limit():
            nonlocal received_bytes
            message = await receive()
            if message["type"] == "http.request":
                received_bytes += len(message.get("body", b""))
                if received_bytes > self.max_request_bytes:
                    raise _UploadRequestTooLarge
            return message

        try:
            await self.app(scope, receive_with_limit, send)
        except _UploadRequestTooLarge:
            response = JSONResponse(
                status_code=413,
                content={"detail": "Multipart upload exceeds the allowed request size."},
            )
            await response(scope, receive, send)
