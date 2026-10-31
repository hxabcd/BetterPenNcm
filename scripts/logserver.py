# 接收词典笔小程序 POST 过来的日志，落到 device_log.txt
# 用法: python scripts/logserver.py
import os
from http.server import BaseHTTPRequestHandler, HTTPServer

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'device_log.txt')


class H(BaseHTTPRequestHandler):
    def _log(self):
        n = int(self.headers.get('Content-Length', 0))
        data = self.rfile.read(n)
        with open(OUT, 'ab') as f:
            f.write(b'\n===== POST ' + self.path.encode('utf-8', 'replace') + b' =====\n')
            f.write(data)
            f.write(b'\n')
        print('received %d bytes -> %s' % (len(data), os.path.abspath(OUT)), flush=True)
        self.send_response(200)
        self.send_header('Content-Length', '2')
        self.end_headers()
        self.wfile.write(b'ok')

    def do_POST(self):
        self._log()

    def do_GET(self):
        self.send_response(200)
        self.send_header('Content-Length', '5')
        self.end_headers()
        self.wfile.write(b'alive')

    def log_message(self, *a):
        pass


if __name__ == '__main__':
    print('log server on 0.0.0.0:8888, writing to', os.path.abspath(OUT), flush=True)
    HTTPServer(('0.0.0.0', 8888), H).serve_forever()
