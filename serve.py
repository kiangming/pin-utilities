#!/usr/bin/env python3
"""
serve.py — Local HTTP server cho SDK Config Analyzer + Game Pipeline
Chạy: python3 serve.py
Truy cập: http://localhost:8080/sdk-config-analyzer.html

Google OAuth yêu cầu HTTP (không phải file://), nên cần chạy qua server này.
Thêm http://localhost:8080 vào "Authorized JavaScript origins" trên Google Cloud Console.
"""
import http.server
import socketserver
import os
import sys
import webbrowser
import threading

PORT = 8080

# Tìm thư mục chứa file HTML (cùng thư mục với serve.py)
SERVE_DIR = os.path.dirname(os.path.abspath(__file__))

class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=SERVE_DIR, **kwargs)

    def log_message(self, format, *args):
        # Chỉ log request (bỏ log noise từ static files nhỏ)
        if any(x in args[0] for x in ['.html', '.js', '.css', '.json']):
            print(f"  {args[0]}")

    def end_headers(self):
        # Cho phép CORS để Sheets API hoạt động
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

def open_browser():
    import time; time.sleep(0.8)
    url = f"http://localhost:{PORT}/sdk-config-analyzer.html"
    webbrowser.open(url)
    print(f"\n  ✅ Đã mở: {url}")

if __name__ == '__main__':
    # Đổi port nếu truyền tham số: python3 serve.py 3000
    if len(sys.argv) > 1:
        try: PORT = int(sys.argv[1])
        except: pass

    os.chdir(SERVE_DIR)
    print(f"\n{'='*55}")
    print(f"  SDK Config Analyzer — Local Server")
    print(f"{'='*55}")
    print(f"  Thư mục : {SERVE_DIR}")
    print(f"  Địa chỉ : http://localhost:{PORT}")
    print(f"  File    : http://localhost:{PORT}/sdk-config-analyzer.html")
    print(f"{'='*55}")
    print(f"  Nhấn Ctrl+C để dừng server\n")

    # Tự động mở browser sau 0.8s
    threading.Thread(target=open_browser, daemon=True).start()

    with socketserver.TCPServer(("", PORT), Handler) as httpd:
        httpd.allow_reuse_address = True
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n\n  Server đã dừng.")
