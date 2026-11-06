#!/usr/bin/env python3
"""Small loopback-only gzip static server for comparable landing CDP tests."""
import argparse
import gzip
import io
import mimetypes
import os
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

COMPRESSIBLE = {".html", ".js", ".css", ".json", ".svg", ".txt", ".xml", ".map"}


class Handler(SimpleHTTPRequestHandler):
    def send_head(self):
        path = self.translate_path(self.path)
        if os.path.isdir(path):
            path = os.path.join(path, "index.html")

        extension = os.path.splitext(path)[1].lower()
        if (
            os.path.isfile(path)
            and extension in COMPRESSIBLE
            and "gzip" in self.headers.get("Accept-Encoding", "")
        ):
            with open(path, "rb") as source:
                payload = gzip.compress(source.read(), compresslevel=5)
            mime = mimetypes.guess_type(path)[0] or "application/octet-stream"
            self.send_response(200)
            self.send_header("Content-Type", mime)
            self.send_header("Content-Encoding", "gzip")
            self.send_header("Vary", "Accept-Encoding")
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            return io.BytesIO(payload)

        return super().send_head()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--directory", required=True)
    args = parser.parse_args()
    server = ThreadingHTTPServer(
        ("127.0.0.1", args.port), partial(Handler, directory=args.directory)
    )
    server.serve_forever()
