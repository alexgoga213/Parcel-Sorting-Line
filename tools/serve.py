"""Local dev server for Parcel Sorting Line: serves the app folder and tells the browser never to cache,
so a refresh always loads the latest code (ES modules are otherwise cached aggressively).

Usage: python tools/serve.py [port]
"""
import functools
import http.server
import os
import sys


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    handler = functools.partial(NoCacheHandler, directory=root)
    with http.server.ThreadingHTTPServer(("127.0.0.1", port), handler) as httpd:
        print(f"Parcel Sorting Line: http://localhost:{port}")
        httpd.serve_forever()


if __name__ == "__main__":
    main()
